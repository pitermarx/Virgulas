import { signal, effect, batch } from '@preact/signals'
import {
  CorruptEnvelopeError,
  WrongPassphraseError,
  MIN_PASSPHRASE_LENGTH
} from "./crypto2.js"
import outline, { CorruptDocumentError, MODEL_VERSION } from "./outline.js"
import { codecStore, jsonCodec, vmdCodec } from './docCodec.js'
import type { OutlineDoc } from './docCodec.js'
import { createKeySession, encrypted, type EncryptedStore } from './encryptedStore.js'
import { slotRaw } from './localStore.js'
import { fileStore } from './fileStore.js'
import { memoryStore } from './memoryStore.js'
import { StoreError, type DocStore, type StringStore, type UnlockResult } from './storage.js'
import {
  detectBrowserCapabilities,
  clearAppCaches,
  isStoragePersistent,
  log,
  requestPersistentStorage,
  store,
  supportsEncryptedStorage
} from './utils.js'
import { biometrics } from './biometrics.js'
import inbox from './inbox.js'
import {
  remoteSync,
  syncStatus,
  pendingConflicts,
  pullAndMerge,
  remoteRekeyed,
  handleSyncFailure,
  startPolling,
  stopPolling,
  setRemoteStore,
  getLastSyncHead,
  setSyncHead,
  skipNextRemotePush,
  setLastSyncedAt,
  noteLocalWriteActivity,
  createRemoteSyncAttempt,
  canStartRemoteSync,
  allowImmediateRemoteSync,
  remoteSyncRetryDelay,
  isRemoteSyncAttemptStale,
  runExclusiveRemoteSync,
  hasSupabaseClient
} from './sync.js'
import { cached } from './cachedStore.js'
import { ensureSupabaseClient, supabaseRaw } from './supabaseBackend.js'

export type PersistenceMode = 'local' | 'remote' | 'filesystem' | 'memory'

export interface UnlockOptions {
  mode?: PersistenceMode
  username?: string
  password?: string
  trustSession?: boolean
}

function normalizeMode(mode: unknown): PersistenceMode | null {
  return mode === 'local' || mode === 'remote' || mode === 'filesystem' || mode === 'memory' ? mode : null
}

function describeBrowserSupport(capabilities: ReturnType<typeof detectBrowserCapabilities>, encryptedStorageAvailable: boolean) {
  const warnings: string[] = []
  if (!encryptedStorageAvailable) {
    const missing = []
    if (!capabilities.cryptoSubtle) missing.push('Web Crypto')
    if (!capabilities.compressionStreams) missing.push('Compression Streams')
    if (!capabilities.localStorage) missing.push('localStorage')
    warnings.push(`Encrypted Local and Remote storage are unavailable because this browser lacks ${missing.join(', ')}. If either mode was selected, the app will continue in Memory without changing the saved mode or encrypted document.`)
  }
  if (!capabilities.indexedDB) {
    warnings.push('IndexedDB is unavailable, so file handles will not be remembered between visits and biometric unlock is unavailable.')
  }
  return warnings.join(' ')
}

// Applies to newly chosen passphrases only; existing (possibly shorter) passphrases
// must keep unlocking.
function assertNewPassphrase(passphrase: string) {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
}

// ── Filesystem (File System Access API, no encryption) ──────────────────────
const filesystemStorage = (function () {
  const IDB_DB = 'virgulas-fs'
  const IDB_STORE = 'handles'
  const IDB_KEY = 'last-file'

  function openIDB(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function getSavedHandle(): Promise<FileSystemFileHandle | null> {
    try {
      const db = await openIDB()
      return new Promise<FileSystemFileHandle | null>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
    } catch { return null }
  }

  async function saveHandle(handle: FileSystemFileHandle): Promise<void> {
    try {
      const db = await openIDB()
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        const req = tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
    } catch { /* ignore */ }
  }

  async function clearHandle(): Promise<void> {
    try {
      const db = await openIDB()
      return new Promise<void>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).delete(IDB_KEY)
        tx.oncomplete = () => resolve()
      })
    } catch { /* ignore */ }
  }

  let _handle: FileSystemFileHandle | null = null

  return {
    isSupported: () => typeof window !== 'undefined' && !!window.showOpenFilePicker,

    async open() {
      const [handle] = await window.showOpenFilePicker!({
        types: [{ description: 'Virgulas document', accept: { 'text/plain': ['.vmd'] } }]
      })
      _handle = handle
      await saveHandle(handle)
      const file = await handle.getFile()
      return await file.text()
    },

    async create() {
      const handle = await window.showSaveFilePicker!({
        suggestedName: 'notes.vmd',
        types: [{ description: 'Virgulas document', accept: { 'text/plain': ['.vmd'] } }]
      })
      _handle = handle
      await saveHandle(handle)
      return null
    },

    async tryReopen() {
      const handle = await getSavedHandle()
      if (!handle) return null
      try {
        const perm = await handle.queryPermission!({ mode: 'readwrite' })
        if (perm === 'denied') return null
        if (perm !== 'granted') {
          const req = await handle.requestPermission!({ mode: 'readwrite' })
          if (req !== 'granted') return null
        }
        _handle = handle
        const file = await handle.getFile()
        return await file.text()
      } catch { return null }
    },

    async hasSavedHandle() {
      const handle = await getSavedHandle()
      return !!handle
    },

    async write(json: string) {
      if (!_handle) throw new Error('No file open')
      const writable = await _handle.createWritable()
      await writable.write(json)
      await writable.close()
    },

    async pickNewFile() {
      _handle = null
      return this.open()
    },

    hasHandle: () => !!_handle,
    currentHandle: () => _handle,

    async clear() {
      _handle = null
      await clearHandle()
    }
  }
})()


const localEncryptedData = {
  get() {
    const v = store.data.get()
    if (!v) {
      return { salt: null, data: null }
    }
    const idx = v.indexOf('|')
    if (idx === -1) {
      log('Invalid encrypted data format, missing "|" salt separator')
      return { salt: null, data: null }
    }
    return { salt: v.substring(0, idx), data: v.substring(idx + 1) }
  },
  reset() {
    store.data.del()
  },
  set(value: string | null, salt: string | null) {
    if (value && salt) {
      store.data.set(salt + '|' + value)
    }
    else if (value || salt) {
      throw new Error('Both value and salt are required to set encrypted data')
    }
    else {
      store.data.del()
    }
  }
}

// -- Storage seam (docs/storage-interface.md, rollout PR 2c) ------------------
//
// Memory/File/Local now route their data paths through the seam:
//   Local   = encrypted(slotRaw(store.data), keySession)  -- StringStore level,
//             so read() returns the decrypted at-rest text for deserialize
//   File    = codecStore(vmdCodec, fileStore(handle))
//   Memory  = codecStore(jsonCodec, memoryStore())        -- validation for free
// Remote keeps its legacy path (including the 'passphrase' signal and
// 'localEncryptedData' for the local cache) until PR 2d cuts it over.
const keySession = createKeySession()
const localDataStore = encrypted(slotRaw(store.data), keySession)

/** data-06: a failed local/file save surfaces here instead of being swallowed. */
export const localSaveFailed = signal(false)

// File mode's document store, rebuilt whenever a handle is (re)acquired.
let fileDataStore: DocStore | null = null

function setFileHandle(handle: FileSystemFileHandle | null) {
  fileDataStore = handle ? codecStore(vmdCodec, fileStore(handle)) : null
}

/**
 * Loads a codec-parsed document into the live outline. VMD-sourced documents
 * carry no model version, so the wrapper supplies one (deserialize validates
 * it); document-level fields already on the doc win over the defaults.
 */
function loadDocIntoOutline(doc: OutlineDoc) {
  outline.deserialize(JSON.stringify({ modelVersion: MODEL_VERSION, dataVersion: 0, ...doc }))
}

/**
 * The Remote composition (docs §4.7/§5): the Supabase row is the source of
 * truth, the local `vmd_data_enc` slot is the offline cache. Both sides share
 * the one KeySession with Local mode, so the two copies always carry the same
 * salt and envelope. Built on remote unlock; torn down on lock/sign-out.
 */
let remoteDataStore: DocStore | null = null
let remotePrimaryStore: EncryptedStore | null = null   // the server side (string level)
let remoteCacheStore: StringStore | null = null        // the local cache side

async function buildRemoteStore(): Promise<DocStore> {
  const client = await ensureSupabaseClient()
  // Composition (docs §5): codec over cached-over-encrypted — the crypto
  // decorator stays codec-blind and the slot/row bytes are unchanged.
  const primary = encrypted(supabaseRaw(client), keySession)
  const cache = encrypted(slotRaw(store.data), keySession)
  remotePrimaryStore = primary
  remoteCacheStore = cache
  return codecStore(jsonCodec, cached(primary, cache))
}

function teardownRemoteStore() {
  remoteDataStore = null
  setRemoteStore(null)
}

/**
 * sync-01 (docs §4.4/§11): a pull met a remote rotated on another device. The
 * session quiesces and locks WITHOUT flushing — flushing would write
 * ciphertext under the stale key and revert the rotation — and the lock screen
 * prompts for the new passphrase. Never followed by a push.
 */
export const remoteRekeyedNotice = signal(false)

effect(() => {
  if (!remoteRekeyed.value) return
  remoteRekeyed.value = false
  stopPolling()
  clearDeferredPush()
  clearPendingSave()
  keySession.lock()
  passphrase.value = ''
  teardownRemoteStore()
  remoteRekeyedNotice.value = true
})

/**
 * Wipes every device-local storage slot that holds user data (priv-01).
 *
 * Clearing only the ciphertext left plaintext residue behind: the quick-capture
 * queue (captured page text), sync timestamps, the scheduled-tasks window, the
 * Inbox node name and the notice-dismissal preference all outlived "Delete
 * local data" and "Delete account". Theme and the (non-secret) Supabase
 * config are the only slots kept — they are device preferences, not content.
 * The biometric seal and the offline shell caches live outside localStorage
 * and are dropped best-effort, as in sign-out.
 */
function wipeDeviceData() {
  inbox.clear()
  localEncryptedData.set(null, null)
  store.user.del()
  store.mode.del()
  store.syncTs.del()
  store.syncHead.del()
  store.scheduledWindow.del()
  store.inboxNodeName.del()
  store.storageNoticeDismissed.del()
  filesystemStorage.clear()
  void biometrics.forget().catch(() => { })
  void clearAppCaches()
}

function rememberMode(mode: unknown) {
  const normalized = normalizeMode(mode)
  if (!normalized) return
  store.mode.set(normalized)
}

function applyHashZoomIfPresent() {
  const nodeParam = window.location.hash.replace('#', '')
  if (!nodeParam) return
  const node = outline.get(nodeParam)
  if (node) {
    outline.zoomIn(nodeParam)
  }
}

const passphrase = signal('')
const authMode = signal('local')
const filesystemReady = signal(false)
const memoryReady = signal(false)
const localStorageDurability = signal<'persistent' | 'best-effort'>('best-effort')
const localStoragePersistenceNotice = signal(false)
let localStoragePersistenceRequest: Promise<boolean> | null = null

function isAppleBrowserTab() {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  const standalone = nav.standalone === true
    || (typeof window !== 'undefined' && !!window.matchMedia?.('(display-mode: standalone)').matches)
  return navigator.vendor === 'Apple Computer, Inc.' && !standalone
}

function updateLocalStorageDurability(persistent: boolean, showNotice: boolean) {
  const isPersistent = persistent && !isAppleBrowserTab()
  localStorageDurability.value = isPersistent ? 'persistent' : 'best-effort'
  if (showNotice && !isPersistent && store.storageNoticeDismissed.get() !== '1') {
    localStoragePersistenceNotice.value = true
  }
}

async function refreshLocalStorageDurability(showNotice: boolean) {
  updateLocalStorageDurability(await isStoragePersistent(), showNotice)
}

function requestLocalStorageDurability(): Promise<boolean> {
  if (!localStoragePersistenceRequest) {
    localStoragePersistenceRequest = requestPersistentStorage().then(persistent => {
      updateLocalStorageDurability(persistent, true)
      return persistent
    })
  }
  return localStoragePersistenceRequest
}

function dismissLocalStoragePersistenceNotice() {
  localStoragePersistenceNotice.value = false
  store.storageNoticeDismissed.set('1')
}

// Set when a sign-up succeeded but produced no session because the project
// requires email confirmation. Consumed by the lock screen so the user gets an
// actionable message instead of an unexplained unlock failure.
let pendingEmailConfirmation = false

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  const baseMs = (typeof window !== 'undefined' && window.__retryBaseMs) ? window.__retryBaseMs : 500
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === maxRetries) throw err
      // Typed non-retryable failures (docs §6.4): a rotated remote or an
      // oversized document will never succeed on retry.
      if (err instanceof StoreError && err.code !== 'network' && err.code !== 'unauthenticated') throw err
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)))
    }
  }
  throw new Error('retryWithBackoff exhausted all attempts')
}

let lastTimeoutId: ReturnType<typeof setTimeout> | null = null

// The save debounce below is reset by every change, so continuous typing would
// postpone autosave (and the remote push) indefinitely. This separate timer is
// armed on the first unsaved change and is NOT cleared by later keystrokes, so a
// save is guaranteed within saveMaxWaitMs even while the user keeps typing.
const saveMaxWaitMs = 3000
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: (() => void) | null = null

// The save effect installs its pipeline here so teardown paths (lock, sign-out)
// can flush pending work — local write then remote push — before the key or the
// session is dropped. `saveArmed` is set whenever a change arms the debounce and
// cleared once a save runs; `lastSavedVersion` records what has been written.
let activeSave: (() => Promise<boolean>) | null = null
let saveArmed = false
let lastSavedVersion = -1

function armMaxWaitSave() {
  if (maxWaitTimer !== null) return
  maxWaitTimer = setTimeout(() => {
    maxWaitTimer = null
    pendingSave?.()
  }, saveMaxWaitMs)
}

function clearMaxWaitSave() {
  if (maxWaitTimer !== null) {
    clearTimeout(maxWaitTimer)
    maxWaitTimer = null
  }
}

// Cancel the debounced autosave outright. Sign-out, account deletion, lock, and
// local purge must call this: a save armed a moment earlier would otherwise fire
// after the session is gone and re-upload (or re-create) the row the user just
// removed. `clearDeferredPush` only covers the retry path, not this timer.
function clearPendingSave() {
  if (lastTimeoutId !== null) {
    clearTimeout(lastTimeoutId)
    lastTimeoutId = null
  }
  pendingSave = null
  clearMaxWaitSave()
}

/**
 * Flush pending work before the session is torn down (lock, sign-out).
 *
 * Cancels the debounce, opens the remote typing gate so the push is not deferred,
 * then runs the save pipeline: the local ciphertext write first, followed by the
 * remote upsert when a remote session is active. Returns false only when the
 * remote push failed — the local write is the durable part and always runs.
 */
export async function flushPendingSave(): Promise<boolean> {
  const save = activeSave
  if (!save) return true
  // Nothing armed and nothing changed since the last write: skip the round trip.
  if (!saveArmed && outline.version.peek() === lastSavedVersion) return true
  clearPendingSave()
  allowImmediateRemoteSync()
  return save()
}

// A remote push is skipped while the user is still typing (`canStartRemoteSync`
// is false until the write debounce elapses). Previously that skip silently
// dropped the push: the edit only reached the server on the next unrelated save.
// These track a deferred push so it is retried once typing stops.
let deferredPushTimer: ReturnType<typeof setTimeout> | null = null
let deferredPushDoc: OutlineDoc | null = null

function clearDeferredPush() {
  if (deferredPushTimer !== null) {
    clearTimeout(deferredPushTimer)
    deferredPushTimer = null
  }
  deferredPushDoc = null
}

/**
 * Schedules the most recent encrypted payload to be pushed once the write
 * debounce has elapsed. Only one retry is ever queued: a newer payload replaces
 * an older one, so the server converges on the latest state.
 */
function scheduleDeferredPush(doc: OutlineDoc) {
  // Only one retry is ever queued: a newer document replaces an older one, so
  // the server converges on the latest state (docs §6.4).
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
  const remote = remoteDataStore
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
      log('[Persistence] Deferred push failed:', error)
      handleSyncFailure(error)
    }
  })
}
effect(() => {
  const mode = authMode.value
  if (mode !== 'remote') return

  const isDirty = outline.isDirty
  if (isDirty) {
    noteLocalWriteActivity()
  }
})

effect(() => {
  const version = outline.version.value // subscribe to changes on doc
  // Also subscribe to the raw write counter. `version` only advances after the
  // outline's own 800ms write debounce fires, and every keystroke restarts that
  // timer — so while the user is actively typing the version never changes and
  // this effect never re-runs, meaning no save (and therefore no sync) is armed
  // at all. Subscribing to dirtyWrites makes the effect react to each change so
  // the save timer is armed immediately.
  void outline.dirtyWrites.value
  const passphraseValue = passphrase.value // subscribe to changes on passphrase
  const fsReady = filesystemReady.value   // subscribe for filesystem mode
  const _memReady = memoryReady.value     // subscribe for memory mode
  const mode = authMode.value

  // Memory mode: no persistence at all
  if (mode === 'memory') {
    activeSave = null
    clearMaxWaitSave()
    return // skip all saves
  }

  // Filesystem mode: plain VMD text, no encryption
  if (mode === 'filesystem' && fsReady) {
    const doWrite = async () => {
      try {
        // Through the seam: live outline -> document -> VMD text -> file.
        await fileDataStore!.write(jsonCodec.parse(outline.serialize()))
        localSaveFailed.value = false
        log('[Persistence] Saved filesystem doc v' + version)
      } catch (error) {
        console.error('[Persistence] Filesystem write failed:', error)
        localSaveFailed.value = true
      }
    }
    const flushWrite = async () => {
      clearMaxWaitSave()
      saveArmed = false
      await doWrite()
      lastSavedVersion = version
      return true
    }
    activeSave = flushWrite
    saveArmed = true
    pendingSave = () => {
      clearMaxWaitSave()
      if (lastTimeoutId) clearTimeout(lastTimeoutId)
      void flushWrite()
    }
    // Bound the debounce so continuous typing cannot postpone the write.
    if (outline.dirtyWrites.peek() > 0) armMaxWaitSave()
    let timeoutId = lastTimeoutId = setTimeout(() => { void flushWrite() }, 1000)
    return () => clearTimeout(timeoutId)
  }

  // Local mode: the encrypted slot store owns the data path (storage seam).
  // The KeySession holds the secret; this branch never handles ciphertext.
  if (mode === 'local') {
    if (!passphraseValue) {
      activeSave = null
      clearMaxWaitSave()
      log('No passphrase, skipping encryption')
      return
    }

    async function doLocalSave(): Promise<boolean> {
      clearMaxWaitSave()
      saveArmed = false
      const json = outline.serialize() // get latest doc state
      try {
        await localDataStore.write(json)
        lastSavedVersion = version
        localSaveFailed.value = false
        // The persist() prompt hangs off the capability, nowhere else.
        if (localDataStore.capabilities.durable === 'prompt') {
          void requestLocalStorageDurability()
        }
        log('[Persistence] Saved encrypted doc v' + version)
        return true
      } catch (error) {
        // data-06: a quota failure surfaces as an error state instead of
        // silently dropping the save.
        console.error('[Persistence] Error saving doc v' + version + ':', error)
        if (error instanceof StoreError && error.code === 'too-large') {
          localSaveFailed.value = true
        }
        return false
      }
    }

    activeSave = doLocalSave
    saveArmed = true
    pendingSave = () => {
      if (lastTimeoutId) clearTimeout(lastTimeoutId)
      void doLocalSave()
    }
    if (outline.dirtyWrites.peek() > 0) armMaxWaitSave()
    let timeoutId = lastTimeoutId = setTimeout(() => { void doLocalSave() }, 1000)
    return () => clearTimeout(timeoutId)
  }

  if (!passphraseValue) {
    activeSave = null
    clearMaxWaitSave()
    log('No passphrase, skipping encryption')
    return
  }

  activeSave = doSave
  saveArmed = true
  pendingSave = () => {
    if (lastTimeoutId) clearTimeout(lastTimeoutId)
    void doSave()
  }
  // Bound the debounce so continuous typing cannot postpone the save.
  if (outline.dirtyWrites.peek() > 0) armMaxWaitSave()

  let timeoutId = lastTimeoutId = setTimeout(() => { void doSave() }, 1000)
  return () => clearTimeout(timeoutId)

  async function doSave(): Promise<boolean> {
    clearMaxWaitSave()
    saveArmed = false
    const remote = remoteDataStore
    if (!remote) return false
    try {
      const doc = jsonCodec.parse(outline.serialize()) // get latest doc state
      lastSavedVersion = version

      // A save that was already in flight when the session ended must not push:
      // signing out / deleting the account locks the KeySession, so the store's
      // write fails unauthenticated and nothing reaches the server.
      if (!canStartRemoteSync()) {
        // Deferring because the user is still typing must not drop the push.
        log('[Persistence] Push deferred until typing pauses')
        scheduleDeferredPush(doc)
        return true
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
          log('[Persistence] Skipping remote push after merge apply')
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
              log('[Persistence] Sync blocked by conflicts')
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
            console.error('[Persistence] Pull-merge failed:', pullErr)
            if (!isRemoteSyncAttemptStale(remoteAttempt)) {
              handleSyncFailure(pullErr)
            }
          }
          return
        }

        // Remote not newer — direct push. The write's returned token is
        // adopted unconditionally: it IS the new head, and the poller must
        // never mistake this device's own push for a remote change (docs §6.4).
        try {
          const token = await retryWithBackoff(() => remote.write(doc))
          if (token) setSyncHead(token)
          if (!isRemoteSyncAttemptStale(remoteAttempt)) {
            setLastSyncedAt(Date.now())
            syncStatus.value = 'synced'
          }
        } catch (syncError) {
          console.error('[Persistence] Remote sync upload failed after retries:', syncError)
          if (!isRemoteSyncAttemptStale(remoteAttempt)) {
            handleSyncFailure(syncError)
          }
        }
      })
      log('[Persistence] Saved doc v' + version)
      return true
    } catch (error) {
      console.error('[Persistence] Error saving doc v' + version + ':', error)
      return false
    }
  }
})

export class RemoteDataDecryptError extends Error {
  constructor() {
    super('Authenticated, but the remote data could not be decrypted with this passphrase.')
    this.name = 'RemoteDataDecryptError'
  }
}

function parseRemoteUnlockError(error: unknown) {
  if (error instanceof StoreError) {
    // Two-channel errors (§4.4): re-throw the original typed error so the lock
    // screen's instanceof branches keep working. The destructive-reset offer
    // triggers on wrong-key only — a corrupt remote is nobody's wrong
    // passphrase.
    if (error.cause instanceof WrongPassphraseError) return error.cause
    if (error.code === 'wrong-key') return new WrongPassphraseError()
    if (error.code === 'corrupt-data' || error.code === 'invalid-document') {
      return new RemoteDataDecryptError()
    }
    return error.cause ?? error
  }
  return error
}

async function unlockLocal(code: string) {
  const hasData = await localDataStore.exists()

  if (!hasData) {
    log('No encrypted data found in localStorage, starting with empty doc')
    assertNewPassphrase(code)
    // Adoption: on an empty store, unlock() retains the passphrase with a
    // fresh salt and the first write persists it (docs §6.2).
    await localDataStore.unlock(code)
    outline.reset()
    outline.addChild('root', { text: '' }) // initialize with one empty node so the doc is never blank
    authMode.value = 'local'
    passphrase.value = code
    rememberMode('local')
    void refreshLocalStorageDurability(false)
    return true
  }

  try {
    // unlock() performs the one-and-only passphrase verification (decryption
    // is the verifier) and returns the decrypted at-rest text.
    const result = await localDataStore.unlock(code)
    if (result.text === null) throw new CorruptEnvelopeError('Local encrypted data is missing.')
    outline.deserialize(result.text)

    batch(() => {
      authMode.value = 'local'
      passphrase.value = code
      applyHashZoomIfPresent()
    })

    rememberMode('local')
    void refreshLocalStorageDurability(true)

    return true
  }
  catch (error) {
    console.error('Error unlocking doc:', error)
    // Two-channel errors: re-throw the original typed error so the lock
    // screen's existing instanceof branches keep working.
    throw error instanceof StoreError ? (error.cause ?? error) : error
  }
}

async function unlockRemote({ passphrase: code, username, password, trustSession }: { passphrase: string; username?: string; password?: string; trustSession?: boolean }) {
  const hasCredentials = !!(username && password)
  if (!trustSession && !hasCredentials) {
    throw new Error('Username, password, and passphrase are required.')
  }
  if (hasCredentials) {
    await remoteSync.signIn(username.trim(), password)
    store.user.set(username.trim())
  }

  const user = await remoteSync.getUser()
  if (!user) {
    // A newly created account that still needs email confirmation has no session,
    // so this is the state the user most often hits. Say so instead of implying
    // the credentials were wrong.
    throw new Error(
      pendingEmailConfirmation
        ? 'Confirm your email address first — the confirmation link creates the session that cloud sync needs.'
        : 'Could not validate remote session. Please sign in again.'
    )
  }
  pendingEmailConfirmation = false
  if (user.email) {
    store.user.set(user.email)
  }

  // Build the cached() composition (server row + local cache slot, one shared
  // KeySession) and verify against the primary — decryption is the verifier
  // (docs §6.2). unlock is primary-only: an offline Remote reload needs
  // connectivity, exactly as before.
  remoteDataStore = await buildRemoteStore()
  setRemoteStore(remoteDataStore)

  // One round-trip: unlock() verifies the passphrase by decrypting the
  // downloaded record and returns its text plus the record's change token
  // (docs §6.2). Primary-only: an offline Remote reload needs connectivity,
  // exactly as before.
  let unlockResult: UnlockResult
  try {
    unlockResult = await remotePrimaryStore!.unlock(code)
  } catch (error) {
    throw parseRemoteUnlockError(error)
  }

  if (!unlockResult.text) {
    // First-time remote setup: no row yet — create the document and push it.
    assertNewPassphrase(code)
    outline.reset()
    outline.addChild('root', { text: 'Hello World' })
    const token = await remoteDataStore.write(jsonCodec.parse(outline.serialize()))
    if (token) setSyncHead(token)
    batch(() => {
      authMode.value = 'remote'
      passphrase.value = code
    })
    rememberMode('remote')
    setLastSyncedAt(Date.now())
    startPolling()
    return true
  }

  const doc = jsonCodec.parse(unlockResult.text)
  outline.deserialize(unlockResult.text)
  // Adopt the downloaded record's token as last-seen (docs §8), and mark the
  // sync baseline so the next edit doesn't falsely see remote as newer.
  if (unlockResult.headToken) setSyncHead(unlockResult.headToken)
  // Prime the offline cache with the remote row (today's behaviour): the two
  // copies share the session, so the salt matches (docs §4.7). Cache-side only —
  // no upsert at unlock time. Best-effort: a failed cache write surfaces via
  // the save-failed state, not a failed unlock.
  try {
    await remoteCacheStore!.write(JSON.stringify({ modelVersion: MODEL_VERSION, dataVersion: 0, ...doc }))
  } catch (error) {
    console.error('[Persistence] Offline cache priming failed:', error)
    if (error instanceof StoreError && error.code === 'too-large') localSaveFailed.value = true
  }
  batch(() => {
    authMode.value = 'remote'
    passphrase.value = code
    applyHashZoomIfPresent()
  })
  rememberMode('remote')
  setLastSyncedAt(Date.now())
  startPolling()
  return true
}

let introVmdCache: string | null = null

async function getIntroVmdText(): Promise<string> {
  if (introVmdCache !== null) return introVmdCache
  try {
    const resp = await fetch('/intro.vmd', { cache: 'no-store' })
    if (resp.ok) {
      introVmdCache = await resp.text()
      return introVmdCache
    }
  } catch { /* ignore */ }
  introVmdCache = ''
  return introVmdCache
}

async function unlockMemory() {
  const introText = await getIntroVmdText()

  outline.reset()
  if (introText && introText.trim()) {
    // Memory mode round-trips through jsonCodec: uniform code path,
    // validation for free (docs §4.6). VMD parsing lives in the codec.
    const memoryDataStore = codecStore(jsonCodec, memoryStore())
    // The jsonCodec-backed store requires a model version on the document.
    await memoryDataStore.write({ modelVersion: MODEL_VERSION, dataVersion: 0, ...vmdCodec.parse(introText) })
    loadDocIntoOutline((await memoryDataStore.read())!)
  } else {
    outline.addChild('root', { text: '' }) // fallback: intro fetch failed, initialize with one empty node
  }

  applyHashZoomIfPresent()

  batch(() => {
    authMode.value = 'memory'
    memoryReady.value = true
  })
  return true
}

async function unlockFilesystem() {
  // Try to reopen the last file silently first
  let json = await filesystemStorage.tryReopen()
  if (json === null) {
    // No saved handle or permission denied — prompt user to open or create
    try {
      json = await filesystemStorage.open()
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') throw new Error('No file selected.')
      throw err
    }
  }

  setFileHandle(filesystemStorage.currentHandle())

  if (json && json.trim()) {
    outline.reset()
    loadDocIntoOutline(vmdCodec.parse(json))
    applyHashZoomIfPresent()
  } else {
    outline.reset()
    outline.addChild('root', { text: '' })
    applyHashZoomIfPresent()
    // Write initial doc with one empty node to file
    await fileDataStore!.write(jsonCodec.parse(outline.serialize()))
  }

  batch(() => {
    authMode.value = 'filesystem'
    filesystemReady.value = true
  })
  rememberMode('filesystem')
  return true
}

async function unlock(code: string, options: UnlockOptions = {}) {
  const mode = options.mode || 'local'
  if (mode === 'memory') {
    return unlockMemory()
  }
  if (mode === 'filesystem') {
    return unlockFilesystem()
  }
  if (mode === 'remote') {
    return unlockRemote({
      passphrase: code,
      username: options.username || '',
      password: options.password || '',
      trustSession: !!options.trustSession
    })
  }
  return unlockLocal(code)
}

export default {
  wipeDeviceData,
  hasData: () => !!localEncryptedData.get().data,
  isLocked: () => !passphrase.value && !filesystemReady.value && !memoryReady.value,
  isMemory: () => memoryReady.value,
  hasFilesystem: () => filesystemStorage.isSupported(),
  getLastUsername: () => store.user.get('') || '',
  /**
   * sec-05: the passphrase string never leaves this module. The only consumer
   * that legitimately needed it was the biometric straight-flow, which now
   * calls this instead of reading `getPassphrase()`.
   */
  async enrollBiometrics(userLabel: string | null = null) {
      const current = passphrase.value
      if (!current) {
          throw new Error('Unlock with a passphrase before enabling biometric unlock.')
      }
      return biometrics.enroll(current, userLabel ?? 'Virgulas user')
  },
  getPreferredMode: () => normalizeMode(store.mode.get(null)),
  /** True when the last sign-up still needs the email confirmed before a session exists. */
  needsEmailConfirmation: () => pendingEmailConfirmation,
  clearEmailConfirmation: () => { pendingEmailConfirmation = false },
  setPreferredMode(mode: string | null) {
    rememberMode(mode)
  },
  hasSupabase: () => hasSupabaseClient(),
  localStorageDurability,
  localStoragePersistenceNotice,
  dismissLocalStoragePersistenceNotice,
  getMode: () => authMode.value,
  getUser: async () => {
    try {
      return await remoteSync.getUser()
    } catch {
      return null
    }
  },
  getAuthBootstrap: async (options: { forceLockScreen?: boolean } = {}) => {
    const browserCapabilities = detectBrowserCapabilities()
    const encryptedStorageAvailable = supportsEncryptedStorage(browserCapabilities)
    const browserSupportWarning = describeBrowserSupport(browserCapabilities, encryptedStorageAvailable)
    const hasLocalData = !!localEncryptedData.get().data
    const hasSupabase = hasSupabaseClient()
    const hasFilesystem = filesystemStorage.isSupported()
    const lastUsername = store.user.get('') || ''
    const preferredMode = normalizeMode(store.mode.get(null))
    let user: any = null
    let hasRemoteData = false

    // Both probes are gated on the mode the user actually persisted, so they stay
    // off the startup path for everyone else: the IndexedDB handle lookup only
    // runs for File mode, and the Supabase chunk (plus its session round trip)
    // is only fetched for Remote mode.
    const hasSavedFileHandle = hasFilesystem && browserCapabilities.indexedDB && preferredMode === 'filesystem'
      ? await filesystemStorage.hasSavedHandle()
      : false

    if (encryptedStorageAvailable && hasSupabase && preferredMode === 'remote') {
      try {
        user = await remoteSync.getUser()
        if (user) {
          // Raw row probe — no decryption, no passphrase (boot has no session).
          hasRemoteData = (await remoteSync.readRow()) !== null
        }
      } catch {
        user = null
      }
    }

    const bootstrapBase = {
      hasLocalData,
      hasSupabase,
      hasFilesystem,
      hasSavedFileHandle,
      lastUsername,
      preferredMode,
      encryptedStorageAvailable,
      browserSupportWarning
    }

    // A confirmed quick-capture visit hands over here, and it must land on the
    // unlock screen rather than in Memory mode: the queue write the user just
    // confirmed is only filed when a persistent mode is unlocked (sec-01).
    // `forceLockScreen` therefore turns every memory outcome into the Local
    // lock screen. Memory stays reachable from there ("Skip — continue in
    // memory"), and the user can navigate away instead.
    const lock = (mode: string, scenario: string, user: any = null) => {
      if (options.forceLockScreen && mode === 'memory') {
        return {
          mode: 'local',
          scenario: hasLocalData ? 'local-present-no-session' : 'empty-local',
          user: null,
          ...bootstrapBase
        }
      }
      return { mode, scenario, user, ...bootstrapBase }
    }

    const encryptedModeWouldBeSelected = preferredMode === 'local' || preferredMode === 'remote'
      || (!preferredMode && (hasLocalData || !!lastUsername))
      || (preferredMode === 'filesystem' && !hasFilesystem)
    if (!encryptedStorageAvailable && encryptedModeWouldBeSelected) {
      return lock('memory', 'memory-unsupported')
    }

    // No remembered mode → check for data signals; if none exist, start in memory mode
    if (!preferredMode) {
      // Respect existing committed SPEC fallbacks for returning users who have data
      if (user && hasRemoteData) return lock('remote', 'remote-session-valid', user)
      if (hasSavedFileHandle && hasFilesystem) return lock('filesystem', 'filesystem-ready')
      if (hasLocalData) return lock('local', 'local-present-no-session')
      if (lastUsername) return lock('remote', 'remote-session-expired')
      // True first-ever visitor: no mode remembered and no data signals → memory mode
      return lock('memory', 'memory-fresh')
    }

    // User explicitly chose in-memory mode — remember it and stay in memory
    if (preferredMode === 'memory') {
      return lock('memory', 'memory-remembered')
    }

    if (preferredMode === 'filesystem' && hasFilesystem) {
      return { mode: 'filesystem', scenario: 'filesystem-ready', user: null, ...bootstrapBase }
    }

    if (preferredMode === 'filesystem') {
      // filesystem preferred but API unavailable — fall back to lock screen for local
      return { mode: 'local', scenario: hasLocalData ? 'local-present-no-session' : 'empty-local', user: null, ...bootstrapBase }
    }

    if (preferredMode === 'remote') {
      if (hasSupabase && user && hasRemoteData) {
        return { mode: 'remote', scenario: 'remote-session-valid', user, ...bootstrapBase }
      }
      return { mode: 'remote', scenario: 'remote-session-expired', user: null, ...bootstrapBase }
    }

    if (preferredMode === 'local') {
      const scenario = hasLocalData ? 'local-present-no-session' : 'empty-local'
      return { mode: 'local', scenario, user: null, ...bootstrapBase }
    }

    // Unknown stored mode value — start fresh in memory
    return { mode: 'memory', scenario: 'memory-fresh', user: null, ...bootstrapBase }
  },
  clearLocalData() {
    void localDataStore.clear()
    // The offline shell and any URL-keyed entry written by an older build live in
    // Cache Storage, outside localStorage; drop them so a purge leaves no device
    // residue. Best-effort, so the synchronous purge need not await it.
    void clearAppCaches()
  },
  async signUp(email: string, password: string) {
    const res = await remoteSync.signUp(email.trim(), password)
    store.user.set(email.trim())
    rememberMode('remote')
    // `res.session` is null when the project requires email confirmation, even
    // though Supabase still returns a user object. Remember it so the lock
    // screen can explain the state instead of silently failing on unlock.
    pendingEmailConfirmation = !!res?.user && !res?.session
    return res
  },
  async resetRemoteData(newPassphrase: string, options: { username?: string; password?: string } = {}) {
    const username = (options.username || '').trim()
    const password = options.password || ''
    if (!newPassphrase) {
      throw new Error('Enter a new passphrase before resetting remote data.')
    }
    assertNewPassphrase(newPassphrase)
    let user = await this.getUser()
    if (!user && username && password) {
      await remoteSync.signIn(username, password)
      store.user.set(username)
      user = await this.getUser()
    }
    if (!user) {
      throw new Error('Could not validate remote session. Sign in again before resetting data.')
    }

    remoteDataStore = await buildRemoteStore()
    setRemoteStore(remoteDataStore)
    // Rotation is the session's job: a fresh salt and the new passphrase become
    // active and the write re-encrypts both copies (docs §6.7).
    keySession.rotate(newPassphrase)
    outline.reset()
    outline.addChild('root', { text: 'Hello World' })
    const token = await remoteDataStore.write(jsonCodec.parse(outline.serialize()))
    if (token) setSyncHead(token)
    batch(() => {
      authMode.value = 'remote'
      passphrase.value = newPassphrase
    })
    rememberMode('remote')
    setLastSyncedAt(Date.now())
    startPolling()
    return true
  },
  syncStatus,
  async lock() {
    // Flush pending work (local write; remote push if a remote session is active)
    // before dropping the key, so locking cannot lose the most recent edit.
    await flushPendingSave()
    stopPolling()
    clearDeferredPush()
    clearPendingSave()
    keySession.lock()
    teardownRemoteStore()
    passphrase.value = ''
    filesystemReady.value = false
    memoryReady.value = false
  },
  async signOut() {
    stopPolling()
    // Push pending edits while the session and passphrase are still valid, so
    // signing out cannot silently drop the last change.
    await flushPendingSave()
    clearDeferredPush()
    clearPendingSave()
    keySession.lock()
    teardownRemoteStore()
    // Drop the passphrase before the remaining awaits so an in-flight save cannot
    // push to a session that is being torn down.
    passphrase.value = ''
    // Revoke the device-local biometric seal: signing out means this device may no
    // longer recover the passphrase without the user typing it.
    await biometrics.forget().catch(() => { })
    await remoteSync.signOut()
    authMode.value = 'remote'
    filesystemReady.value = false
    rememberMode('remote')
  },
  /**
   * Deletes the signed-in user's server-side data, then clears the local session
   * and signs out.
   *
   * The encrypted `outlines` row is removed through the RLS-scoped DELETE policy.
   * The `auth.users` record itself is NOT removed: deleting it requires the
   * service role, which the browser client never holds. Local data is cleared
   * regardless, so the device cannot resurrect the deleted document.
   */
  async deleteAccount() {
    const user = await remoteSync.getUser()
    if (!user) {
      throw new Error('Not signed in. Sign in again before deleting your account.')
    }

    // Stop background writes before the row disappears, so an in-flight upload
    // cannot recreate it after deletion. Clearing the passphrase here (not after
    // the awaits) invalidates any save that is already past its timer.
    stopPolling()
    clearDeferredPush()
    clearPendingSave()
    keySession.lock()
    passphrase.value = ''

    await remoteSync.deleteOutline()

    // Local cleanup: wipe every device-local slot so nothing survives on a
    // shared device (priv-01) — the capture queue, sync metadata, remembered
    // mode and username, the ciphertext, the biometric seal, and the offline
    // shell caches.
    wipeDeviceData()

    await remoteSync.signOut()
    authMode.value = 'remote'
    filesystemReady.value = false
    memoryReady.value = false
  },
  async pickNewFile() {
    const text = await filesystemStorage.pickNewFile()
    setFileHandle(filesystemStorage.currentHandle())
    if (text && text.trim()) {
      outline.reset()
      loadDocIntoOutline(vmdCodec.parse(text))
      applyHashZoomIfPresent()
    } else {
      outline.reset()
      await fileDataStore!.write(jsonCodec.parse(outline.serialize()))
    }
    rememberMode('filesystem')
  },
  reset() {
    clearDeferredPush()
    clearPendingSave()
    keySession.lock()
    localSaveFailed.value = false
    outline.reset()
    authMode.value = 'local'
    passphrase.value = ''
    filesystemReady.value = false
    memoryReady.value = false
    wipeDeviceData()
  },
  async changePassphrase(newPassphrase: string) {
    if (!newPassphrase) {
      throw new Error('New passphrase cannot be empty.')
    }
    assertNewPassphrase(newPassphrase)
    const mode = authMode.value
    if (mode === 'memory' || mode === 'filesystem') {
      throw new Error('This mode has no encryption passphrase.')
    }
    const json = outline.serialize()

    if (mode === 'local') {
      // Storage seam: rotation is the session's job -- a fresh salt and the
      // new passphrase become active and the write re-encrypts (docs §6.7).
      keySession.rotate(newPassphrase)
      await localDataStore.write(json)
      passphrase.value = newPassphrase
      return true
    }

    if (mode === 'remote') {
      const user = await remoteSync.getUser()
      if (!user) {
        throw new Error('Not signed in. Sign in before changing the passphrase.')
      }
      // Rotation is the session's job (docs §6.7): both copies are re-encrypted
      // under the new salt by this write.
      keySession.rotate(newPassphrase)
      const remote = remoteDataStore ?? await buildRemoteStore()
      remoteDataStore = remote
      setRemoteStore(remote)
      const token = await remote.write(jsonCodec.parse(json))
      if (token) setSyncHead(token)
      setLastSyncedAt(Date.now())
    }

    passphrase.value = newPassphrase
    return true
  },
  exportVmd() {
    return outline.getVMD('root')
  },
  importVmd(vmdText: string) {
    outline.reset()
    if (vmdText && vmdText.trim()) {
      outline.setRootVMD(vmdText)
    } else {
      outline.addChild('root', { text: '' })
    }
    return true
  },
  unlock
}
