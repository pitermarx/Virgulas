import { signal, effect, batch } from '@preact/signals'
import { encrypt, decrypt, generateSalt, MIN_PASSPHRASE_LENGTH } from "./crypto2.js"
import outline from "./outline.js"
import { log, store } from './utils.js'
import { biometrics } from './biometrics.js'
import inbox from './inbox.js'
import {
  remoteSync,
  syncStatus,
  pendingConflicts,
  pullAndMerge,
  checkRemoteNewer,
  startPolling,
  stopPolling,
  setCredentials,
  clearCredentials,
  skipNextRemotePush,
  setLastSyncedAt,
  noteLocalWriteActivity,
  createRemoteSyncAttempt,
  canStartRemoteSync,
  remoteSyncRetryDelay,
  isRemoteSyncAttemptStale,
  beginRemotePush,
  recordCompletedRemotePush,
  runExclusiveRemoteSync,
  hasSupabaseClient
} from './sync.js'

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

// Test hook: allows E2E tests to trigger hash zoom without a full page reload
window.__applyHashZoomIfPresent = applyHashZoomIfPresent

const passphrase = signal('')
const authMode = signal('local')
const filesystemReady = signal(false)
const memoryReady = signal(false)

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

// A remote push is skipped while the user is still typing (`canStartRemoteSync`
// is false until the write debounce elapses). Previously that skip silently
// dropped the push: the edit only reached the server on the next unrelated save.
// These track a deferred push so it is retried once typing stops.
let deferredPushTimer: ReturnType<typeof setTimeout> | null = null
let deferredPushPayload: { encrypted: string; salt: string; passphrase: string } | null = null

function clearDeferredPush() {
  if (deferredPushTimer !== null) {
    clearTimeout(deferredPushTimer)
    deferredPushTimer = null
  }
  deferredPushPayload = null
}

/**
 * Schedules the most recent encrypted payload to be pushed once the write
 * debounce has elapsed. Only one retry is ever queued: a newer payload replaces
 * an older one, so the server converges on the latest state.
 */
function scheduleDeferredPush(encrypted: string, salt: string, passphrase: string) {
  deferredPushPayload = { encrypted, salt, passphrase }
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
  const payload = deferredPushPayload
  // Keep the payload until the retry actually runs; a later edit replaces it.
  if (!payload) return
  if (!canStartRemoteSync()) {
    // Still typing — re-arm for the remaining deferral.
    scheduleDeferredPush(payload.encrypted, payload.salt, payload.passphrase)
    return
  }
  if (pendingConflicts.peek().length > 0) {
    // A merge is pending; the conflict flow owns the upload.
    deferredPushPayload = null
    return
  }

  const attempt = createRemoteSyncAttempt()
  await runExclusiveRemoteSync(async () => {
    if (pendingConflicts.peek().length > 0) return
    // This push targets whatever the latest payload is, not a specific edit, so
    // it must not bail on a newer write epoch — the whole point is to converge
    // the server on the newest state once typing pauses.

    try {
      syncStatus.value = 'syncing'
      const lastSyncedAt = parseInt(store.syncTs.get('0') || '0') || 0
      let isRemoteNewer = false
      try {
        isRemoteNewer = await checkRemoteNewer(lastSyncedAt)
      } catch { /* proceed with a direct push */ }

      if (isRemoteNewer) {
        const result = await pullAndMerge(payload.passphrase, payload.salt)
        if (!result.clean) {
          syncStatus.value = 'synced'
          deferredPushPayload = null
          return
        }
        if (result.mergedJson) {
          const mergedEncrypted = await encrypt(result.mergedJson, payload.passphrase, payload.salt)
          const updatedAt = beginRemotePush(attempt)
          await retryWithBackoff(() => remoteSync.upsert(mergedEncrypted, payload.salt, updatedAt))
          recordCompletedRemotePush(attempt)
          localEncryptedData.set(mergedEncrypted, payload.salt)
          setLastSyncedAt(Date.now())
          skipNextRemotePush.value = true
          outline.deserialize(result.mergedJson)
          syncStatus.value = 'synced'
          deferredPushPayload = null
          return
        }
      }

      const updatedAt = beginRemotePush(attempt)
      await retryWithBackoff(() => remoteSync.upsert(payload.encrypted, payload.salt, updatedAt))
      recordCompletedRemotePush(attempt)
      setLastSyncedAt(Date.now())
      syncStatus.value = 'synced'
      deferredPushPayload = null
    } catch (error) {
      log('[Persistence] Deferred push failed:', error)
      syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
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
    clearMaxWaitSave()
    return // skip all saves
  }

  // Filesystem mode: plain VMD text, no encryption
  if (mode === 'filesystem' && fsReady) {
    const doWrite = async () => {
      try {
        const vmd = outline.getVMD('root')
        await filesystemStorage.write(vmd)
        log('[Persistence] Saved filesystem doc v' + version)
      } catch (error) {
        console.error('[Persistence] Filesystem write failed:', error)
      }
    }
    pendingSave = () => {
      clearMaxWaitSave()
      if (lastTimeoutId) clearTimeout(lastTimeoutId)
      void doWrite()
    }
    // Bound the debounce so continuous typing cannot postpone the write.
    if (outline.dirtyWrites.peek() > 0) armMaxWaitSave()
    let timeoutId = lastTimeoutId = setTimeout(async () => {
      clearMaxWaitSave()
      await doWrite()
    }, 1000)
    return () => clearTimeout(timeoutId)
  }

  if (!passphraseValue) {
    clearMaxWaitSave()
    log('No passphrase, skipping encryption')
    return
  }

  const saltValue: string = localEncryptedData.get().salt || generateSalt()

  pendingSave = () => {
    if (lastTimeoutId) clearTimeout(lastTimeoutId)
    void doSave()
  }
  // Bound the debounce so continuous typing cannot postpone the save.
  if (outline.dirtyWrites.peek() > 0) armMaxWaitSave()

  let timeoutId = lastTimeoutId = setTimeout(doSave, 1000)
  return () => clearTimeout(timeoutId)

  async function doSave() {
    clearMaxWaitSave()
    const pass = passphraseValue
    const salt = saltValue
    try {
      log('[Persistence] Compressing and encrypting doc v' + version + '...')
      const json = outline.serialize() // get latest doc state
      const encrypted = await encrypt(json, pass, salt)
      localEncryptedData.set(encrypted, salt)
      if (mode === 'remote' && pendingConflicts.peek().length === 0) {
        // Deferring because the user is still typing must not drop the push.
        if (!canStartRemoteSync()) {
          log('[Persistence] Push deferred until typing pauses')
          scheduleDeferredPush(encrypted, salt, pass)
          return
        }
        const remoteAttempt = createRemoteSyncAttempt()
        await runExclusiveRemoteSync(async () => {
          if (!canStartRemoteSync() || isRemoteSyncAttemptStale(remoteAttempt)) {
            // Superseded by newer typing: queue the latest payload instead of
            // silently abandoning this edit's remote push.
            scheduleDeferredPush(encrypted, salt, pass)
            return
          }

          // Skip remote push if a merge was just applied (prevents double-push)
          if (skipNextRemotePush.peek()) {
            skipNextRemotePush.value = false
            log('[Persistence] Skipping remote push after merge apply')
            return
          }

          clearDeferredPush()
          syncStatus.value = 'syncing'

          // Pull-before-push: check if remote has changes since last sync
          const lastSyncedAt = parseInt(store.syncTs.get('0') || '0') || 0
          let isRemoteNewer = false
          try {
            isRemoteNewer = await checkRemoteNewer(lastSyncedAt)
          } catch { /* ignore, proceed with direct push */ }

          if (isRemoteSyncAttemptStale(remoteAttempt)) return

          if (isRemoteNewer) {
            try {
              const result = await pullAndMerge(pass, salt)
              if (isRemoteSyncAttemptStale(remoteAttempt)) return

              if (!result.clean) {
                log('[Persistence] Sync blocked by conflicts')
                syncStatus.value = 'synced'
                return
              }

              if (result.mergedJson) {
                const mergedEncrypted = await encrypt(result.mergedJson, pass, salt)
                if (isRemoteSyncAttemptStale(remoteAttempt)) return
                const updatedAt = beginRemotePush(remoteAttempt)
                await retryWithBackoff(() => remoteSync.upsert(mergedEncrypted, salt, updatedAt))
                recordCompletedRemotePush(remoteAttempt)
                if (isRemoteSyncAttemptStale(remoteAttempt)) return
                localEncryptedData.set(mergedEncrypted, salt)
                setLastSyncedAt(Date.now())
                syncStatus.value = 'synced'
                // Apply merged doc; flag prevents the triggered save from re-pushing
                skipNextRemotePush.value = true
                outline.deserialize(result.mergedJson)
              } else {
                // Remote not newer after all (race) or no data to merge
                const updatedAt = beginRemotePush(remoteAttempt)
                await retryWithBackoff(() => remoteSync.upsert(encrypted, salt, updatedAt))
                recordCompletedRemotePush(remoteAttempt)
                if (!isRemoteSyncAttemptStale(remoteAttempt)) {
                  setLastSyncedAt(Date.now())
                  syncStatus.value = 'synced'
                }
              }
            } catch (pullErr) {
              console.error('[Persistence] Pull-merge failed:', pullErr)
              if (!isRemoteSyncAttemptStale(remoteAttempt)) {
                syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
              }
            }
            return
          }

          // Remote not newer — direct push
          try {
            const updatedAt = beginRemotePush(remoteAttempt)
            await retryWithBackoff(() => remoteSync.upsert(encrypted, salt, updatedAt))
            recordCompletedRemotePush(remoteAttempt)
            if (!isRemoteSyncAttemptStale(remoteAttempt)) {
              setLastSyncedAt(Date.now())
              syncStatus.value = 'synced'
            }
          } catch (syncError) {
            console.error('[Persistence] Remote sync upload failed after retries:', syncError)
            if (!isRemoteSyncAttemptStale(remoteAttempt)) {
              syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
            }
          }
        })
      }
      log('[Persistence] Saved encrypted doc v' + version + ' length=', encrypted.length)
    } catch (error) {
      console.error('[Persistence] Error encrypting doc v' + version + ':', error)
    }
  }
})

function parseRemoteDecryptError(error: unknown) {
  const message = String((error as { message?: string } | null)?.message || '')
  if (message.includes('Invalid password') || message.includes('corrupted')) {
    return new Error('Authenticated, but data could not be decrypted with this passphrase. You can reset remote data with a new passphrase.')
  }
  return error
}

async function unlockLocal(code: string) {
  const { salt, data } = localEncryptedData.get()

  if (data) {
    if (!salt) {
      log('Invalid encrypted data format, missing salt')
      return false
    }
  }
  else {
    log('No encrypted data found in localStorage, starting with empty doc')
    assertNewPassphrase(code)
    outline.reset()
    outline.addChild('root', { text: '' }) // initialize with one empty node so the doc is never blank
    authMode.value = 'local'
    passphrase.value = code
    rememberMode('local')
    return true
  }

  try {
    const json = await decrypt(data, code, salt)

    batch(() => {
      authMode.value = 'local'
      passphrase.value = code
      outline.deserialize(json)
      applyHashZoomIfPresent()
    })

    rememberMode('local')

    return true
  }
  catch (error) {
    console.error('Error unlocking doc:', error)
    return false
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

  const remoteData = await remoteSync.read()
  if (!remoteData?.data) {
    assertNewPassphrase(code)
    const salt = localEncryptedData.get().salt || generateSalt()
    outline.reset()
    outline.addChild('root', { text: 'Hello World' })
    const json = outline.serialize()
    const encrypted = await encrypt(json, code, salt)
    await remoteSync.upsert(encrypted, salt)
    localEncryptedData.set(encrypted, salt)
    batch(() => {
      authMode.value = 'remote'
      passphrase.value = code
    })
    rememberMode('remote')
    setLastSyncedAt(Date.now())
    setCredentials(code, salt)
    startPolling()
    return true
  }

  const remoteSalt = remoteData.salt || localEncryptedData.get().salt
  if (!remoteSalt) {
    throw new Error('Missing remote salt. Please sign in again.')
  }

  try {
    const json = await decrypt(remoteData.data, code, remoteSalt)
    batch(() => {
      authMode.value = 'remote'
      passphrase.value = code
      outline.deserialize(json)
      applyHashZoomIfPresent()
    })
    localEncryptedData.set(remoteData.data, remoteSalt)
    rememberMode('remote')
    // Mark sync timestamp so next edit doesn't falsely detect remote as newer
    setLastSyncedAt(Date.now())
    setCredentials(code, remoteSalt)
    startPolling()
    return true
  } catch (error) {
    throw parseRemoteDecryptError(error)
  }
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
    outline.setRootVMD(introText)
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

  if (json && json.trim()) {
    outline.reset()
    outline.setRootVMD(json)
    applyHashZoomIfPresent()
  } else {
    outline.reset()
    outline.addChild('root', { text: '' })
    applyHashZoomIfPresent()
    // Write initial doc with one empty node to file
    await filesystemStorage.write(outline.getVMD('root'))
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
  hasData: () => !!localEncryptedData.get().data,
  isLocked: () => !passphrase.value && !filesystemReady.value && !memoryReady.value,
  isMemory: () => memoryReady.value,
  hasFilesystem: () => filesystemStorage.isSupported(),
  getPassphrase: () => passphrase.value,
  getLastUsername: () => store.user.get('') || '',
  getPreferredMode: () => normalizeMode(store.mode.get(null)),
  /** True when the last sign-up still needs the email confirmed before a session exists. */
  needsEmailConfirmation: () => pendingEmailConfirmation,
  clearEmailConfirmation: () => { pendingEmailConfirmation = false },
  setPreferredMode(mode: string | null) {
    rememberMode(mode)
  },
  hasSupabase: () => hasSupabaseClient(),
  getMode: () => authMode.value,
  getUser: async () => {
    try {
      return await remoteSync.getUser()
    } catch {
      return null
    }
  },
  getAuthBootstrap: async () => {
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
    const hasSavedFileHandle = hasFilesystem && preferredMode === 'filesystem'
      ? await filesystemStorage.hasSavedHandle()
      : false

    if (hasSupabase && preferredMode === 'remote') {
      try {
        user = await remoteSync.getUser()
        if (user) {
          const remote = await remoteSync.read()
          hasRemoteData = !!remote?.data
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
      preferredMode
    }

    // No remembered mode → check for data signals; if none exist, start in memory mode
    if (!preferredMode) {
      // Respect existing committed SPEC fallbacks for returning users who have data
      if (user && hasRemoteData) return { mode: 'remote', scenario: 'remote-session-valid', user, ...bootstrapBase }
      if (hasSavedFileHandle && hasFilesystem) return { mode: 'filesystem', scenario: 'filesystem-ready', user: null, ...bootstrapBase }
      if (hasLocalData) return { mode: 'local', scenario: 'local-present-no-session', user: null, ...bootstrapBase }
      if (lastUsername) return { mode: 'remote', scenario: 'remote-session-expired', user: null, ...bootstrapBase }
      // True first-ever visitor: no mode remembered and no data signals → memory mode
      return { mode: 'memory', scenario: 'memory-fresh', user: null, ...bootstrapBase }
    }

    // User explicitly chose in-memory mode — remember it and stay in memory
    if (preferredMode === 'memory') {
      return { mode: 'memory', scenario: 'memory-remembered', user: null, ...bootstrapBase }
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
    localEncryptedData.set(null, null)
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

    const salt = generateSalt()
    outline.reset()
    outline.addChild('root', { text: 'Hello World' })
    const json = outline.serialize()
    const encrypted = await encrypt(json, newPassphrase, salt)
    await remoteSync.upsert(encrypted, salt)
    localEncryptedData.set(encrypted, salt)
    batch(() => {
      authMode.value = 'remote'
      passphrase.value = newPassphrase
    })
    rememberMode('remote')
    setLastSyncedAt(Date.now())
    setCredentials(newPassphrase, salt)
    startPolling()
    return true
  },
  syncStatus,
  lock() {
    stopPolling()
    clearDeferredPush()
    clearCredentials()
    passphrase.value = ''
    filesystemReady.value = false
    memoryReady.value = false
  },
  async signOut() {
    stopPolling()
    clearDeferredPush()
    clearCredentials()
    // Revoke the device-local biometric seal: signing out means this device may no
    // longer recover the passphrase without the user typing it.
    await biometrics.forget().catch(() => { })
    await remoteSync.signOut()
    authMode.value = 'remote'
    passphrase.value = ''
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
    // cannot recreate it after deletion.
    stopPolling()
    clearDeferredPush()
    clearCredentials()

    await remoteSync.deleteOutline()

    // Local cleanup: queue, biometric seal, remembered mode, and ciphertext.
    await biometrics.forget().catch(() => { })
    inbox.clear()
    localEncryptedData.set(null, null)
    store.user.del()
    store.mode.del()
    store.syncTs.del()

    await remoteSync.signOut()
    authMode.value = 'remote'
    passphrase.value = ''
    filesystemReady.value = false
    memoryReady.value = false
  },
  async pickNewFile() {
    const text = await filesystemStorage.pickNewFile()
    if (text && text.trim()) {
      outline.reset()
      outline.setRootVMD(text)
      applyHashZoomIfPresent()
    } else {
      outline.reset()
      await filesystemStorage.write(outline.getVMD('root'))
    }
    rememberMode('filesystem')
  },
  reset() {
    outline.reset()
    localEncryptedData.set(null, null)
    authMode.value = 'local'
    passphrase.value = ''
    filesystemReady.value = false
    memoryReady.value = false
    store.mode.del()
    store.user.del()
    filesystemStorage.clear()
    // Purging local data must also drop the device-local biometric seal, otherwise
    // the wrapped passphrase would outlive the data it protects.
    void biometrics.forget().catch(() => { })
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
    const salt = generateSalt()
    const encrypted = await encrypt(json, newPassphrase, salt)

    if (mode === 'remote') {
      const user = await remoteSync.getUser()
      if (!user) {
        throw new Error('Not signed in. Sign in before changing the passphrase.')
      }
      await remoteSync.upsert(encrypted, salt)
      setLastSyncedAt(Date.now())
      setCredentials(newPassphrase, salt)
    }

    localEncryptedData.set(encrypted, salt)
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
