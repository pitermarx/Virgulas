import { signal, effect, batch } from '@preact/signals'
import {
  WrongPassphraseError,
  MIN_PASSPHRASE_LENGTH
} from "./crypto2.js"
import outline, { MODEL_VERSION } from "./outline.js"
import { codecStore, jsonCodec, vmdCodec } from './docCodec.js'
import type { OutlineDoc } from './docCodec.js'
import { createKeySession, encrypted } from './encryptedStore.js'
import { slotRaw } from './localStore.js'
import { fileStore } from './fileStore.js'
import { fileHandleStore } from './fileHandles.js'
import { memoryStore } from './memoryStore.js'
import { parseBackendConfig, StoreError, type BackendConfig, type DocStore, type UnlockResult } from './storage.js'
import {
  detectBrowserCapabilities,
  clearAppCaches,
  clearLegacySupabaseSessions,
  log,
  store,
  supportsEncryptedStorage
} from './utils.js'
import { biometrics } from './biometrics.js'
import {
  dismissLocalStoragePersistenceNotice,
  localStorageDurability,
  localStoragePersistenceNotice,
  refreshLocalStorageDurability,
  requestLocalStorageDurability
} from './durability.js'
import inbox from './inbox.js'
import { createSavePipeline } from './savePipeline.js'
import {
  remoteSync,
  startPolling,
  stopPolling,
  backend
} from './sync.js'
import {
  syncStatus,
  remoteRekeyed,
  setSyncHead,
  setLastSyncedAt,
  noteLocalWriteActivity,
  allowImmediateRemoteSync,
  setRemoteStore,
  getRemoteStore,
  syncOnce,
  createRemoteSyncAttempt,
  canStartRemoteSync,
  skipNextRemotePush
} from './syncEngine.js'
import { cached } from './cachedStore.js'

export type PersistenceMode = 'local' | 'remote' | 'filesystem' | 'memory'

export interface UnlockOptions {
  mode?: PersistenceMode
  username?: string
  password?: string
  trustSession?: boolean
  /** Document value to adopt when the store is empty (first-time setup) —
   * the running in-memory document (the intro tour, with the user's edits)
   * carries over instead of being replaced by the seed doc. */
  initialDoc?: OutlineDoc
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

// -- Storage seam (docs/storage-interface.md) --------------------------------
//
// All four modes route their data paths through the seam:
//   Local   = codecStore(jsonCodec, encrypted(slotRaw(store.data), keySession))
//   File    = codecStore(vmdCodec, fileStore(handle))
//   Memory  = the live outline (no store instance; see §14)
//   Remote  = codecStore(jsonCodec, cached(encrypted(raw), encrypted(slotRaw)))
//             -- one shared KeySession for the server row and the local cache
const keySession = createKeySession()

/** Reactive mirror of `keySession.unlocked` for the save effect and the lock
 * screen. The passphrase itself never leaves KeySession (docs §4.3); this flag
 * is all the orchestration and the UI ever hold. */
const sessionUnlocked = signal(false)

function markSessionUnlocked() {
  sessionUnlocked.value = keySession.unlocked
}

const localDataStore = codecStore(jsonCodec, encrypted(slotRaw(store.data), keySession))

/** data-06: a failed local/file save surfaces here instead of being swallowed. */
export const localSaveFailed = signal(false)

// File mode's document store, rebuilt whenever a handle is (re)acquired.
let fileDataStore: DocStore | null = null

function setFileHandle(handle: FileSystemFileHandle | null) {
  fileDataStore = handle ? codecStore(vmdCodec, fileStore(handle)) : null
}

/**
 * Loads a codec-parsed document into the live outline. VMD-sourced documents
 * carry no model version, so the wrapper supplies one (load validates it);
 * document-level fields already on the doc win over the defaults.
 */
function loadDocIntoOutline(doc: OutlineDoc) {
  outline.load({ modelVersion: MODEL_VERSION, dataVersion: 0, ...doc })
}

/**
 * A parsed VMD document with no nodes beyond the implicit root is an empty
 * file: treat it like a blank one (seed an empty node) instead of loading an
 * outline the user cannot type in.
 */
function hasDocumentNodes(doc: OutlineDoc | null): doc is OutlineDoc {
  return !!doc && doc.nodes.some(node => node.id !== 'root')
}

/**
 * The Remote composition (docs §4.7/§5): the server row is the source of
 * truth, the local `vmd_data_enc` slot is the offline cache. Both sides share
 * the one KeySession with Local mode, so the two copies always carry the same
 * salt and envelope. Built on remote unlock, handed to `remoteSave.ts` (which
 * owns saves, retries and the deferred push), torn down on lock/sign-out.
 */
let remoteCacheStore: DocStore | null = null          // the local cache side, doc-level

/** The configured sync backend (resolved by `sync.ts`). */
function getBackendConfig(): BackendConfig {
  return parseBackendConfig(store.backend.get())
}

function setBackendConfig(config: BackendConfig) {
  store.backend.set(JSON.stringify(config))
}

/** The configured backend's kind — UI branching (messages, labels). */
function getBackendKind(): BackendConfig['backend'] {
  return getBackendConfig().backend
}

async function buildRemoteStore(): Promise<DocStore> {
  const { raw } = await backend()
  // Composition (docs §5): codec over cached-over-encrypted — the crypto
  // decorator stays codec-blind and the slot/row bytes are unchanged.
  const primary = encrypted(raw, keySession)
  const cache = encrypted(slotRaw(store.data), keySession)
  remoteCacheStore = codecStore(jsonCodec, cache)
  return codecStore(jsonCodec, cached(primary, cache, {
    // data-06 in Remote mode: the server row is the source of truth, so a
    // failed device-local cache write must not fail the save or read as a
    // sync error. The status toolbar reports "not saved locally" until the
    // next cache write succeeds.
    onCacheWrite(error) {
      localSaveFailed.value = error !== null
      if (error) console.error('[Persistence] Offline cache write failed:', error)
    }
  }))
}

/**
 * The Remote save edge. Every save keeps the durable local copy first: while the
 * user is typing, only the network push waits (SPEC: uploads after typing
 * pauses), so no edit is ever held only in memory. Once typing stops the engine
 * pushes, pulling before pushing and merging as needed. A merge already applied
 * locally is persisted again here but never pushed back.
 */
async function saveRemoteDocument(doc: OutlineDoc) {
  if (!remoteCacheStore || !getRemoteStore()) return
  const merged = skipNextRemotePush.peek()
  if (merged) skipNextRemotePush.value = false
  if (merged || !canStartRemoteSync()) {
    try {
      await remoteCacheStore.write(doc)
      localSaveFailed.value = false
    } catch (error) {
      localSaveFailed.value = true
      console.error('[Persistence] Offline cache write failed:', error)
    }
    return
  }
  await syncOnce({ doc, attempt: createRemoteSyncAttempt() })
}

function teardownRemoteStore() {
  // Nulls the sync module's store and the cache handle in one place.
  setRemoteStore(null)
  remoteCacheStore = null
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
  stopPolling()  clearPendingSave()
  keySession.lock()
  markSessionUnlocked()
  teardownRemoteStore()
  remoteRekeyedNotice.value = true
})

/**
 * Wipes every device-local storage slot that holds user data (priv-01).
 *
 * Clearing only the ciphertext left plaintext residue behind: the quick-capture
 * queue (captured page text), sync timestamps, the scheduled-tasks window, the
 * Inbox node name, the backend auth sessions and the notice-dismissal
 * preference all outlived "Delete local data" and "Delete account". Theme and
 * the (non-secret) Supabase config are the only slots kept — they are device
 * preferences, not content. The biometric seal and the offline shell caches
 * live outside localStorage and are dropped best-effort, as in sign-out.
 */
function wipeDeviceData() {
  inbox.clear()
  void localDataStore.clear()
  store.user.del()
  store.mode.del()
  store.syncTs.del()
  store.syncHead.del()
  store.backendSession.del()
  store.supabaseSession.del()
  clearLegacySupabaseSessions()
  store.scheduledWindow.del()
  store.inboxNodeName.del()
  store.storageNoticeDismissed.del()
  fileHandleStore.clear()
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

const authMode = signal<PersistenceMode>('local')
const filesystemReady = signal(false)
const memoryReady = signal(false)
// Set when a sign-up succeeded but produced no session because the project
// requires email confirmation. Consumed by the lock screen so the user gets an
// actionable message instead of an unexplained unlock failure.
let pendingEmailConfirmation = false

const savePipeline = createSavePipeline({
  mode: () => authMode.value,
  isUnlocked: () => sessionUnlocked.value,
  isFilesystemReady: () => filesystemReady.value,
  localStore: localDataStore,
  fileStore: () => fileDataStore,
  setLocalSaveFailed: (failed) => { localSaveFailed.value = failed },
  requestDurability: () => { void requestLocalStorageDurability() },
  saveRemote: saveRemoteDocument,
  noteWriteActivity: noteLocalWriteActivity,
  allowImmediateSync: allowImmediateRemoteSync
})
savePipeline.install()

/** Flush pending work before lock/sign-out; false only when the remote push failed. */
const flushPendingSave = savePipeline.flush
const clearPendingSave = savePipeline.clear

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

/** Adopts an initial document value (first-time setup from memory).
 * Guarantees the doc is never blank: returns false when nothing usable was
 * adopted, so the caller can seed its default. */
function adoptInitialDoc(initialDoc: OutlineDoc | undefined): boolean {
  if (!initialDoc) return false
  try {
    outline.load(initialDoc)
    const root = outline.get('root')
    return !!root && root.children.peek().length > 0
  } catch {
    return false
  }
}

/** First-time Local setup: activate the KeySession with a fresh salt and seed
 * the live model. The first write persists it (docs §6.2). */
function setupLocal(code: string, initialDoc?: OutlineDoc) {
  assertNewPassphrase(code)
  outline.reset()
  // When setting up from a running memory document, adopt it so the user's
  // notes survive; otherwise the doc is never blank.
  if (!adoptInitialDoc(initialDoc)) {
    outline.addChild('root', { text: '' })
  }
  authMode.value = 'local'
  markSessionUnlocked()
  rememberMode('local')
  void refreshLocalStorageDurability(false)
  return true
}

async function unlockLocal(code: string, initialDoc?: OutlineDoc) {
  const hasData = await localDataStore.exists()

  if (!hasData) {
    log('No encrypted data found in localStorage, starting with empty doc')
    await localDataStore.unlock!(code)
    return setupLocal(code, initialDoc)
  }

  try {
    // unlock() performs the one-and-only passphrase verification (decryption
    // is the verifier) in one round-trip (docs §14.7). It returns the at-rest
    // text, which the codec parses into the document value the orchestration
    // handles; reads and writes below are doc-level.
    const result = await localDataStore.unlock!(code)
    if (!result || result.text === null) {
      // The slot is occupied but holds no readable record (a value without
      // the `<salt>|<envelope>` shape reads as "no record"). Match the
      // pre-seam behaviour: treat it as first-time setup.
      log('Local data is unreadable, starting with a new document')
      return setupLocal(code, initialDoc)
    }
    outline.load(jsonCodec.parse(result.text))

    batch(() => {
      authMode.value = 'local'
      markSessionUnlocked()
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

async function unlockRemote({ passphrase: code, username, password, trustSession, initialDoc }: { passphrase: string; username?: string; password?: string; trustSession?: boolean; initialDoc?: OutlineDoc }) {
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
  const remote = await buildRemoteStore()
  setRemoteStore(remote)

  // One round-trip: unlock() verifies the passphrase by decrypting the
  // downloaded record and returns its text plus the record's change token
  // (docs §4.3/§6.2). The composition passes the primary's result through, so
  // the orchestration never holds a string-level handle on the server store.
  // Primary-only: an offline Remote reload needs connectivity, as before.
  let unlockResult: UnlockResult
  try {
    const result = await remote.unlock?.(code)
    if (!result) throw new Error('The Remote store did not report an unlocked document.')
    unlockResult = result
  } catch (error) {
    throw parseRemoteUnlockError(error)
  }

  if (!unlockResult.text) {
    // First-time remote setup: no row yet — create the document and push it.
    // When setting up from a running memory document (the intro tour, with the
    // user's edits), adopt it instead of the seed doc (docs: storage setup).
    assertNewPassphrase(code)
    outline.reset()
    if (!adoptInitialDoc(initialDoc)) {
      outline.addChild('root', { text: 'Hello World' })
    }
    const token = await remote.write(outline.snapshot())
    if (token) setSyncHead(token)
    batch(() => {
      authMode.value = 'remote'
      markSessionUnlocked()
    })
    rememberMode('remote')
    setLastSyncedAt(Date.now())
    startPolling()
    return true
  }

  const doc = jsonCodec.parse(unlockResult.text)
  outline.load(doc)
  // Adopt the downloaded record's token as last-seen (docs §8), and mark the
  // sync baseline so the next edit doesn't falsely see remote as newer.
  if (unlockResult.headToken) setSyncHead(unlockResult.headToken)
  // Prime the offline cache with the remote row (today's behaviour): the two
  // copies share the session, so the salt matches (docs §4.7). Cache-side only —
  // no upsert at unlock time. Best-effort: a failed cache write surfaces via
  // the save-failed state, not a failed unlock.
  try {
    await remoteCacheStore!.write({ modelVersion: MODEL_VERSION, dataVersion: 0, ...doc })
  } catch (error) {
    console.error('[Persistence] Offline cache priming failed:', error)
    if (error instanceof StoreError && error.code === 'too-large') localSaveFailed.value = true
  }
  batch(() => {
    authMode.value = 'remote'
    markSessionUnlocked()
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
    // Memory mode round-trips the intro through jsonCodec: validation for
    // free (docs §4.6); the live outline itself is the store (§14.12).
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

async function unlockFilesystem(initialDoc?: OutlineDoc) {
  // Reopen the remembered handle silently, otherwise ask for a file. Handle
  // acquisition is orchestration; the bytes are the file store's job.
  if (!(await fileHandleStore.tryReopen())) {
    try {
      await fileHandleStore.open()
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') throw new Error('No file selected.')
      throw err
    }
  }

  setFileHandle(fileHandleStore.currentHandle())

  const doc = await fileDataStore!.read()
  if (hasDocumentNodes(doc)) {
    outline.reset()
    loadDocIntoOutline(doc)
    applyHashZoomIfPresent()
  } else if (adoptInitialDoc(initialDoc)) {
    // A new empty file chosen from a running memory session: the live document
    // becomes the file's content (docs: storage setup).
    applyHashZoomIfPresent()
  } else {
    outline.reset()
    outline.addChild('root', { text: '' })
    applyHashZoomIfPresent()
    // Write initial doc with one empty node to file
    await fileDataStore!.write(outline.snapshot())
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
    return unlockFilesystem(options.initialDoc)
  }
  if (mode === 'remote') {
    return unlockRemote({
      passphrase: code,
      username: options.username || '',
      password: options.password || '',
      trustSession: !!options.trustSession,
      initialDoc: options.initialDoc
    })
  }
  return unlockLocal(code, options.initialDoc)
}

export default {
  wipeDeviceData,
  isLocked: () => !sessionUnlocked.value && !filesystemReady.value && !memoryReady.value,
  isMemory: () => memoryReady.value,
  hasFilesystem: () => fileHandleStore.isSupported(),
  getLastUsername: () => store.user.get('') || '',
  /**
   * sec-05: the passphrase never leaves KeySession. The only consumer that
   * legitimately needed it was the biometric straight-flow, which reads the
   * active credentials here instead of a `getPassphrase()` accessor.
   */
  async enrollBiometrics(userLabel: string | null = null) {
      const current = keySession.activeCredentials()?.passphrase
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
  getBackendConfig,
  setBackendConfig,
  getBackendKind,
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
    const hasLocalData = await localDataStore.exists()
    const hasFilesystem = fileHandleStore.isSupported()
    const lastUsername = store.user.get('') || ''
    const preferredMode = normalizeMode(store.mode.get(null))
    let user: any = null
    let hasRemoteData = false

    // Both probes are gated on the mode the user actually persisted, so they stay
    // off the startup path for everyone else: the IndexedDB handle lookup only
    // runs for File mode, and the Supabase chunk (plus its session round trip)
    // is only fetched for Remote mode.
    const hasSavedFileHandle = hasFilesystem && browserCapabilities.indexedDB && preferredMode === 'filesystem'
      ? await fileHandleStore.hasSavedHandle()
      : false

    if (encryptedStorageAvailable && preferredMode === 'remote') {
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
      if (user && hasRemoteData) {
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
  async requestPasswordReset(email: string) {
    await remoteSync.requestPasswordReset(email.trim())
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

    const remote = await buildRemoteStore()
    setRemoteStore(remote)
    // Rotation is the session's job: a fresh salt and the new passphrase become
    // active and the write re-encrypts both copies (docs §6.7).
    keySession.rotate(newPassphrase)
    outline.reset()
    outline.addChild('root', { text: 'Hello World' })
    const token = await remote.write(outline.snapshot())
    if (token) setSyncHead(token)
    batch(() => {
      authMode.value = 'remote'
      markSessionUnlocked()
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
    stopPolling()    clearPendingSave()
    keySession.lock()
    teardownRemoteStore()
    markSessionUnlocked()
    filesystemReady.value = false
    memoryReady.value = false
  },
  async signOut() {
    stopPolling()
    // Push pending edits while the session is still unlocked, so signing out
    // cannot silently drop the last change.
    await flushPendingSave()    clearPendingSave()
    keySession.lock()
    teardownRemoteStore()
    // Lock the session before the remaining awaits so an in-flight save cannot
    // push to a session that is being torn down.
    markSessionUnlocked()
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
   * The encrypted `outlines` row is removed through the RLS/ACL-scoped DELETE
   * policy. On a backend with self-service account deletion (TrailBase) the auth
   * record is removed too; Supabase's `auth.users` row needs the service role,
   * which the browser client never holds, so it survives and the Options copy
   * says so. Local data is cleared regardless, so the device cannot resurrect
   * the deleted document.
   */
  async deleteAccount() {
    const user = await remoteSync.getUser()
    if (!user) {
      throw new Error('Not signed in. Sign in again before deleting your account.')
    }

    // Stop background writes before the row disappears, so an in-flight upload
    // cannot recreate it after deletion. Locking the key session here (not after
    // the awaits) invalidates any save that is already past its timer.
    stopPolling()    clearPendingSave()
    keySession.lock()
    markSessionUnlocked()

    await getRemoteStore()?.clear() ?? await remoteSync.deleteOutline()

    // §4.5 step 4: remove the auth record itself when the backend supports
    // self-service deletion (TrailBase does; Supabase does not — its auth
    // record survives, and the Options copy says so).
    try {
      await remoteSync.deleteUser()
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== 'unsupported') throw error
    }

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
    await fileHandleStore.pickNewFile()
    setFileHandle(fileHandleStore.currentHandle())
    const doc = await fileDataStore!.read()
    if (hasDocumentNodes(doc)) {
      outline.reset()
      loadDocIntoOutline(doc)
      applyHashZoomIfPresent()
    } else {
      outline.reset()
      await fileDataStore!.write(outline.snapshot())
    }
    rememberMode('filesystem')
  },
  reset() {    clearPendingSave()
    keySession.lock()
    markSessionUnlocked()
    localSaveFailed.value = false
    outline.reset()
    authMode.value = 'local'
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
    const doc = outline.snapshot()

    if (mode === 'local') {
      // Storage seam: rotation is the session's job -- a fresh salt and the
      // new passphrase become active and the write re-encrypts (docs §6.7).
      keySession.rotate(newPassphrase)
      await localDataStore.write(doc)
      markSessionUnlocked()
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
      const remote = getRemoteStore() ?? await buildRemoteStore()
      setRemoteStore(remote)
      const token = await remote.write(doc)
      if (token) setSyncHead(token)
      setLastSyncedAt(Date.now())
    }

    markSessionUnlocked()
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
