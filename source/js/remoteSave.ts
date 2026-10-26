// Remote save orchestration (docs §6.4): pull-before-push, the retry policy,
// and the deferred push that keeps a typing-time edit from being dropped.
//
// `persistence.ts` owns the session lifecycle, the debounce and the store
// construction; once a document is ready to upload it comes here. Every write
// goes through the injected DocStore (codec + cached + encrypted), so this
// module never sees ciphertext, keys or backend specifics.

import outline from './outline.js'
import { jsonCodec, type OutlineDoc } from './docCodec.js'
import { StoreError, type DocStore } from './storage.js'
import {
  syncStatus,
  pendingConflicts,
  pullAndMerge,
  handleSyncFailure,
  setRemoteStore,
  getLastSyncHead,
  setSyncHead,
  skipNextRemotePush,
  setLastSyncedAt,
  createRemoteSyncAttempt,
  canStartRemoteSync,
  remoteSyncRetryDelay,
  isRemoteSyncAttemptStale,
  runExclusiveRemoteSync
} from './sync.js'
import { log } from './utils.js'

// ── Store injection ─────────────────────────────────────────────────────────

let remoteStore: DocStore | null = null

/**
 * The composed Remote store (codec over cached-over-encrypted) used for saves
 * and deferred flushes. Injecting it here also hands the same instance to
 * `sync.ts`, so polling and merge read exactly what saves write. Null tears
 * the remote session down.
 */
export function setRemoteSaveStore(store: DocStore | null) {
  remoteStore = store
  setRemoteStore(store)
}

export function getRemoteSaveStore(): DocStore | null {
  return remoteStore
}

// ── Retry policy (docs §6.4) ────────────────────────────────────────────────

/**
 * Retries only the typed failures a retry can fix: transport/5xx (`network`)
 * and a session that is temporarily missing (`unauthenticated`). Everything
 * else — a rotated remote, an oversized document, rejected input — throws
 * immediately, because the same request cannot succeed on retry.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  const baseMs = (typeof window !== 'undefined' && window.__retryBaseMs) ? window.__retryBaseMs : 500
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === maxRetries) throw err
      if (err instanceof StoreError && err.code !== 'network' && err.code !== 'unauthenticated') throw err
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)))
    }
  }
  throw new Error('retryWithBackoff exhausted all attempts')
}

// ── Deferred push ───────────────────────────────────────────────────────────

// A remote push is skipped while the user is still typing (`canStartRemoteSync`
// is false until the write debounce elapses). Previously that skip silently
// dropped the push: the edit only reached the server on the next unrelated save.
// These track a deferred push so it is retried once typing stops.
let deferredPushTimer: ReturnType<typeof setTimeout> | null = null
let deferredPushDoc: OutlineDoc | null = null

/** Cancel the queued retry. Teardown paths call this before dropping a session. */
export function clearDeferredPush() {
  if (deferredPushTimer !== null) {
    clearTimeout(deferredPushTimer)
    deferredPushTimer = null
  }
  deferredPushDoc = null
}

/**
 * Schedules the most recent document to be pushed once the write debounce has
 * elapsed. Only one retry is ever queued: a newer document replaces an older
 * one, so the server converges on the latest state.
 */
function scheduleDeferredPush(doc: OutlineDoc) {
  deferredPushDoc = doc
  if (deferredPushTimer !== null) {
    clearTimeout(deferredPushTimer)
  }
  // +50ms so we land just after `remoteSyncNotBefore` rather than exactly on it.
  const delay = remoteSyncRetryDelay() + 50
  deferredPushTimer = setTimeout(() => {
    deferredPushTimer = null
    void flushDeferredPush()
  }, delay)
}

async function flushDeferredPush() {
  const doc = deferredPushDoc
  // Keep the document until the retry actually runs; a later edit replaces it.
  if (!doc) return
  const remote = remoteStore
  if (!remote) return
  if (!canStartRemoteSync()) {
    // Still typing — re-arm for the remaining deferral.
    scheduleDeferredPush(doc)
    return
  }
  if (pendingConflicts.peek().length > 0) {
    // A merge is pending; the conflict flow owns the upload.
    deferredPushDoc = null
    return
  }

  const attempt = createRemoteSyncAttempt()
  await runExclusiveRemoteSync(async () => {
    if (pendingConflicts.peek().length > 0) return
    // This flush writes whatever the latest queued document is, not a specific
    // edit, so it must not bail on a newer write epoch — the whole point is to
    // converge the server on the newest state once typing pauses.

    try {
      syncStatus.value = 'syncing'
      // Pull-before-push still applies to a flush: converge without clobbering
      // a newer remote (docs §6.4).
      let headToken: string | null = null
      try {
        headToken = await remote.head?.() ?? null
      } catch { /* proceed with a direct write */ }

      if (headToken && headToken !== getLastSyncHead()) {
        const result = await pullAndMerge()
        if (!result.clean) {
          syncStatus.value = 'synced'
          deferredPushDoc = null
          return
        }
        const mergedJson = result.mergedJson
        if (mergedJson) {
          const mergedToken = await retryWithBackoff(() => remote.write(jsonCodec.parse(mergedJson)))
          if (mergedToken) setSyncHead(mergedToken)
          setLastSyncedAt(Date.now())
          skipNextRemotePush.value = true
          outline.deserialize(mergedJson)
          syncStatus.value = 'synced'
          deferredPushDoc = null
          return
        }
      }

      // A flush re-runs the store write — cache and primary (docs §6.4).
      const token = await retryWithBackoff(() => remote.write(doc))
      if (token) setSyncHead(token)
      setLastSyncedAt(Date.now())
      syncStatus.value = 'synced'
      deferredPushDoc = null
    } catch (error) {
      log('[RemoteSave] Deferred push failed:', error)
      handleSyncFailure(error)
    }
  })
}

// ── Save ────────────────────────────────────────────────────────────────────

/**
 * Pushes one parsed document through the composed Remote store, preserving the
 * pull-before-push rule: when the primary's head token moved since this device
 * last saw it, pull and merge first, then write the merged document — or leave
 * the upload to the conflict flow.
 *
 * The caller owns the debounce, the saved-version bookkeeping and the outer
 * error logging. Failed pushes are mapped onto the sync status here and never
 * thrown: a network failure must not fail the local autosave.
 */
export async function saveRemoteDocument(doc: OutlineDoc): Promise<void> {
  const remote = remoteStore
  if (!remote) return

  // A save that was already in flight when the session ended must not push:
  // signing out / deleting the account locks the KeySession, so the store's
  // write fails unauthenticated and nothing reaches the server.
  if (!canStartRemoteSync()) {
    // Deferring because the user is still typing must not drop the push.
    log('[RemoteSave] Push deferred until typing pauses')
    scheduleDeferredPush(doc)
    return
  }

  const remoteAttempt = createRemoteSyncAttempt()
  await runExclusiveRemoteSync(async () => {
    if (isRemoteSyncAttemptStale(remoteAttempt)) {
      // Superseded by newer typing: queue the latest document instead of
      // silently abandoning this edit's remote push.
      scheduleDeferredPush(doc)
      return
    }

    // Skip remote push if a merge was just applied (prevents double-push).
    // The merge path already wrote both copies through the store.
    if (skipNextRemotePush.peek()) {
      skipNextRemotePush.value = false
      log('[RemoteSave] Skipping remote push after merge apply')
      return
    }

    clearDeferredPush()
    syncStatus.value = 'syncing'

    // Pull-before-push: the primary changed since our last-seen head token?
    let headToken: string | null = null
    try {
      headToken = await remote.head?.() ?? null
    } catch { /* ignore, proceed with direct write */ }

    if (isRemoteSyncAttemptStale(remoteAttempt)) return

    if (headToken && headToken !== getLastSyncHead()) {
      try {
        const result = await pullAndMerge()
        if (isRemoteSyncAttemptStale(remoteAttempt)) return

        if (!result.clean) {
          log('[RemoteSave] Sync blocked by conflicts')
          syncStatus.value = 'synced'
          return
        }

        const mergedJson = result.mergedJson
        if (mergedJson) {
          const mergedToken = await retryWithBackoff(() => remote.write(jsonCodec.parse(mergedJson)))
          if (isRemoteSyncAttemptStale(remoteAttempt)) return
          if (mergedToken) setSyncHead(mergedToken)
          setLastSyncedAt(Date.now())
          syncStatus.value = 'synced'
          // Apply merged doc; flag prevents the triggered save from re-pushing
          skipNextRemotePush.value = true
          outline.deserialize(mergedJson)
        } else {
          // Remote not newer after all (race) or no data to merge
          const token = await remote.write(doc)
          if (token) setSyncHead(token)
          if (!isRemoteSyncAttemptStale(remoteAttempt)) {
            setLastSyncedAt(Date.now())
            syncStatus.value = 'synced'
          }
        }
      } catch (pullErr) {
        console.error('[RemoteSave] Pull-merge failed:', pullErr)
        if (!isRemoteSyncAttemptStale(remoteAttempt)) {
          handleSyncFailure(pullErr)
        }
      }
      return
    }

    // Remote not newer — direct push. The write's returned token is adopted
    // unconditionally: it IS the new head, and the poller must never mistake
    // this device's own push for a remote change (docs §6.4).
    try {
      const token = await retryWithBackoff(() => remote.write(doc))
      if (token) setSyncHead(token)
      if (!isRemoteSyncAttemptStale(remoteAttempt)) {
        setLastSyncedAt(Date.now())
        syncStatus.value = 'synced'
      }
    } catch (syncError) {
      console.error('[RemoteSave] Remote sync upload failed after retries:', syncError)
      if (!isRemoteSyncAttemptStale(remoteAttempt)) {
        handleSyncFailure(syncError)
      }
    }
  })
}
