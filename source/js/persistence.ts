import { signal, effect, batch } from '@preact/signals'
import {
  WrongPassphraseError,
  MIN_PASSPHRASE_LENGTH
} from "./crypto2.js"
import outline, { CorruptDocumentError, MODEL_VERSION } from "./outline.js"
import { codecStore, jsonCodec, vmdCodec } from './docCodec.js'
import type { OutlineDoc } from './docCodec.js'
import { createKeySession, encrypted } from './encryptedStore.js'
import { slotRaw } from './localStore.js'
import { fileStore } from './fileStore.js'
import { memoryStore } from './memoryStore.js'
import { parseBackendConfig, StoreError, type BackendConfig, type DocStore, type UnlockResult } from './storage.js'
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
  remoteRekeyed,
  startPolling,
  stopPolling,
  setSyncHead,
  setLastSyncedAt,
  noteLocalWriteActivity,
  allowImmediateRemoteSync,
  hasSupabaseClient,
  backend
} from './sync.js'
import { cached } from './cachedStore.js'
import {
  clearDeferredPush,
  getRemoteSaveStore,
  saveRemoteDocument,
  setRemoteSaveStore
} from './remoteSave.js'

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

    /** Acquires a handle from the picker. Reading is the file store's job. */
    async open() {
      const [handle] = await window.showOpenFilePicker!({
        types: [{ description: 'Virgulas document', accept: { 'text/plain': ['.vmd'] } }]
      })
      _handle = handle
      await saveHandle(handle)
    },

    /** Reopens the remembered handle; false means "ask the user". */
    async tryReopen() {
      const handle = await getSavedHandle()
      if (!handle) return false
      try {
        const perm = await handle.queryPermission!({ mode: 'readwrite' })
        if (perm === 'denied') return false
        if (perm !== 'granted') {
          const req = await handle.requestPermission!({ mode: 'readwrite' })
          if (req !== 'granted') return false
        }
        // Probe readability: a deleted/inaccessible file falls back to the picker.
        await handle.getFile()
        _handle = handle
        return true
      } catch { return false }
    },

    async hasSavedHandle() {
      const handle = await getSavedHandle()
      return !!handle
    },

    async pickNewFile() {
      _handle = null
      await this.open()
    },

    currentHandle: () => _handle,

    async clear() {
      _handle = null
      await clearHandle()
    }
  }
})()


// -- Storage seam (docs/storage-interface.md) --------------------------------
//
// All four modes route their data paths through the seam:
//   Local   = codecStore(jsonCodec, encrypted(slotRaw(store.data), keySession))
//   File    = codecStore(vmdCodec, fileStore(handle))
//   Memory  = the live outline (no store instance; see §14)
//   Remote  = codecStore(jsonCodec, cached(encrypted(raw), encrypted(slotRaw)))
//             -- one shared KeySession for the server row and the local cache
const keySession = createKeySession()
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

function teardownRemoteStore() {
  // Nulls the save handle, the sync module's store and the cache handle in one place.
  setRemoteSaveStore(null)
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
  void localDataStore.clear()
  store.user.del()
  store.mode.del()
  store.syncTs.del()
  store.syncHead.del()
  store.backendSession.del()
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
// is false until the write debounce elapses) and retried once it stops. That
// queue and its pull-before-push flow live in remoteSave.ts.
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
        await fileDataStore!.write(outline.snapshot())
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
      const doc = outline.snapshot() // get latest doc state
      try {
        await localDataStore.write(doc)
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
    if (!getRemoteSaveStore()) return false
    try {
      const doc = outline.snapshot() // get latest doc state
      lastSavedVersion = version
      // Pull-before-push, retries and the typing-time deferral live in
      // remoteSave.ts; failures there map onto the sync status, not this save.
      await saveRemoteDocument(doc)
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

/** First-time Local setup: retain the passphrase with a fresh salt and seed
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
  passphrase.value = code
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
  setRemoteSaveStore(remote)

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
      passphrase.value = code
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
  if (!(await filesystemStorage.tryReopen())) {
    try {
      await filesystemStorage.open()
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') throw new Error('No file selected.')
      throw err
    }
  }

  setFileHandle(filesystemStorage.currentHandle())

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
    setRemoteSaveStore(remote)
    // Rotation is the session's job: a fresh salt and the new passphrase become
    // active and the write re-encrypts both copies (docs §6.7).
    keySession.rotate(newPassphrase)
    outline.reset()
    outline.addChild('root', { text: 'Hello World' })
    const token = await remote.write(outline.snapshot())
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

    await getRemoteSaveStore()?.clear() ?? await remoteSync.deleteOutline()

    // §4.5 step 4: remove the auth record itself when the backend supports
    // self-service deletion (TrailBase does; Supabase does not — its auth
    // record survives, and the UI says so).
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
    await filesystemStorage.pickNewFile()
    setFileHandle(filesystemStorage.currentHandle())
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
    const doc = outline.snapshot()

    if (mode === 'local') {
      // Storage seam: rotation is the session's job -- a fresh salt and the
      // new passphrase become active and the write re-encrypts (docs §6.7).
      keySession.rotate(newPassphrase)
      await localDataStore.write(doc)
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
      const remote = getRemoteSaveStore() ?? await buildRemoteStore()
      setRemoteSaveStore(remote)
      const token = await remote.write(doc)
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
