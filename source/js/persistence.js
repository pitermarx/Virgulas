import { signal, effect, batch } from '@preact/signals'
import { encrypt, decrypt, generateSalt } from "./crypto2.js"
import outline from "./outline.js"
import { log, store } from './utils.js'
import { devPersistence } from './devtools.js'
import quickUnlock from './quickUnlock.js'
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
  setLastSyncedAt
} from './sync.js'

function normalizeMode(mode) {
  return mode === 'local' || mode === 'remote' || mode === 'filesystem' || mode === 'memory' ? mode : null
}

function normalizeAccountId(accountId) {
  return String(accountId || '').trim().toLowerCase()
}

function resolveRemoteAccountId({ user, fallback = '' } = {}) {
  return normalizeAccountId(user?.email || fallback || store.user.get('') || '')
}

// ── Filesystem (File System Access API, no encryption) ──────────────────────
const filesystemStorage = (function () {
  const IDB_DB = 'virgulas-fs'
  const IDB_STORE = 'handles'
  const IDB_KEY = 'last-file'

  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function getSavedHandle() {
    try {
      const db = await openIDB()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
    } catch { return null }
  }

  async function saveHandle(handle) {
    try {
      const db = await openIDB()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        const req = tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
    } catch { /* ignore */ }
  }

  async function clearHandle() {
    try {
      const db = await openIDB()
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        tx.objectStore(IDB_STORE).delete(IDB_KEY)
        tx.oncomplete = () => resolve()
      })
    } catch { /* ignore */ }
  }

  let _handle = null

  return {
    isSupported: () => typeof window !== 'undefined' && !!window.showOpenFilePicker,

    async open() {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Virgulas document', accept: { 'text/plain': ['.vmd'] } }]
      })
      _handle = handle
      await saveHandle(handle)
      const file = await handle.getFile()
      return await file.text()
    },

    async create() {
      const handle = await window.showSaveFilePicker({
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
        const perm = await handle.queryPermission({ mode: 'readwrite' })
        if (perm === 'denied') return null
        if (perm !== 'granted') {
          const req = await handle.requestPermission({ mode: 'readwrite' })
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

    async write(json) {
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
  set(value, salt) {
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

function rememberMode(mode) {
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
    devPersistence.hashApplied.value = true
  }
}

// Test hook: allows E2E tests to trigger hash zoom without a full page reload
window.__applyHashZoomIfPresent = applyHashZoomIfPresent

const passphrase = signal('')
const authMode = signal('local')
const filesystemReady = signal(false)
const memoryReady = signal(false)

async function retryWithBackoff(fn, maxRetries = 3) {
  const baseMs = (typeof window !== 'undefined' && window.__retryBaseMs) ? window.__retryBaseMs : 500
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === maxRetries) throw err
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)))
    }
  }
}

let lastTimeoutId = null
effect(() => {
  const version = outline.version.value // subscribe to changes on doc
  const passphraseValue = passphrase.value // subscribe to changes on passphrase
  const fsReady = filesystemReady.value   // subscribe for filesystem mode
  const _memReady = memoryReady.value     // subscribe for memory mode
  const mode = authMode.value

  // Memory mode: no persistence at all
  if (mode === 'memory') {
    return // skip all saves
  }

  // Filesystem mode: plain VMD text, no encryption
  if (mode === 'filesystem' && fsReady) {
    let timeoutId = lastTimeoutId = setTimeout(async () => {
      try {
        if (lastTimeoutId !== timeoutId) return
        const vmd = outline.getVMD('root')
        await filesystemStorage.write(vmd)
        log('[Persistence] Saved filesystem doc v' + version)
      } catch (error) {
        console.error('[Persistence] Filesystem write failed:', error)
      }
    }, 1000)
    return () => clearTimeout(timeoutId)
  }

  if (!passphraseValue) {
    log('No passphrase, skipping encryption')
    return
  }

  let saltValue = localEncryptedData.get().salt
  if (!saltValue) {
    log('No salt found, creating new salt for encryption')
    saltValue = generateSalt()
  }

  let timeoutId = lastTimeoutId = setTimeout(async () => {
    try {
      log('[Persistence] Compressing and encrypting doc v' + version + '...')
      const json = outline.serialize() // get latest doc state
      if (lastTimeoutId !== timeoutId) {
        log('[Persistence] Newer encryption in progress, skipping this one')
        return
      }
      const encrypted = await encrypt(json, passphraseValue, saltValue)
      if (lastTimeoutId !== timeoutId) {
        log('[Persistence] Newer encryption in progress, skipping this one')
        return
      }
      localEncryptedData.set(encrypted, saltValue)
      if (mode === 'remote' && pendingConflicts.peek().length === 0) {
        // Skip remote push if a merge was just applied (prevents double-push)
        if (skipNextRemotePush.peek()) {
          skipNextRemotePush.value = false
          log('[Persistence] Skipping remote push after merge apply')
          return
        }

        syncStatus.value = 'syncing'

        // Pull-before-push: check if remote has changes since last sync
        const lastSyncedAt = parseInt(store.syncTs.get('0') || '0') || 0
        let isRemoteNewer = false
        try {
          isRemoteNewer = await checkRemoteNewer(lastSyncedAt)
        } catch { /* ignore, proceed with direct push */ }

        if (lastTimeoutId !== timeoutId) return

        if (isRemoteNewer) {
          try {
            const result = await pullAndMerge(passphraseValue, saltValue)
            if (lastTimeoutId !== timeoutId) return

            if (!result.clean) {
              log('[Persistence] Sync blocked by conflicts')
              syncStatus.value = 'synced'
              return
            }

            if (result.mergedJson) {
              const mergedEncrypted = await encrypt(result.mergedJson, passphraseValue, saltValue)
              if (lastTimeoutId !== timeoutId) return
              await retryWithBackoff(() => remoteSync.upsert(mergedEncrypted, saltValue))
              if (lastTimeoutId === timeoutId) {
                localEncryptedData.set(mergedEncrypted, saltValue)
                setLastSyncedAt(Date.now())
                syncStatus.value = 'synced'
              }
              // Apply merged doc; flag prevents the triggered save from re-pushing
              skipNextRemotePush.value = true
              outline.deserialize(result.mergedJson)
            } else {
              // Remote not newer after all (race) or no data to merge
              await retryWithBackoff(() => remoteSync.upsert(encrypted, saltValue))
              if (lastTimeoutId === timeoutId) {
                setLastSyncedAt(Date.now())
                syncStatus.value = 'synced'
              }
            }
          } catch (pullErr) {
            console.error('[Persistence] Pull-merge failed:', pullErr)
            if (lastTimeoutId === timeoutId) {
              syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
            }
          }
          return
        }

        // Remote not newer — direct push
        try {
          await retryWithBackoff(() => remoteSync.upsert(encrypted, saltValue))
          if (lastTimeoutId === timeoutId) {
            setLastSyncedAt(Date.now())
            syncStatus.value = 'synced'
          }
        } catch (syncError) {
          console.error('[Persistence] Remote sync upload failed after retries:', syncError)
          if (lastTimeoutId === timeoutId) {
            syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
          }
        }
      }
      log('[Persistence] Saved encrypted doc v' + version + ' length=', encrypted.length)
    } catch (error) {
      console.error('[Persistence] Error encrypting doc v' + version + ':', error)
    }
  }, 1000) // debounce encryption by 1 second

  return () => clearTimeout(timeoutId)
})

function parseRemoteDecryptError(error) {
  const message = String(error?.message || '')
  if (message.includes('Invalid password') || message.includes('corrupted')) {
    return new Error('Authenticated, but data could not be decrypted with this passphrase. You can reset remote data with a new passphrase.')
  }
  return error
}

function shouldForgetQuickUnlockFromUnlockError(error) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes('could not be decrypted')
    || message.includes('invalid password')
    || message.includes('corrupted')
    || message.includes('missing remote salt')
}

function removeQuickUnlockRecord(mode, accountId = '') {
  if (mode === 'local') {
    quickUnlock.removeSavedPassphrase({ mode: 'local' })
    return
  }
  const normalizedAccountId = normalizeAccountId(accountId)
  if (!normalizedAccountId) return
  quickUnlock.removeSavedPassphrase({ mode: 'remote', accountId: normalizedAccountId })
}

async function unlockWithSavedQuickUnlock(options = {}) {
  const mode = options.mode === 'remote' ? 'remote' : 'local'
  const normalizedAccountId = mode === 'remote'
    ? normalizeAccountId(options.accountId || options.username)
    : ''

  if (!quickUnlock.hasSavedPassphrase({ mode, accountId: normalizedAccountId })) {
    return { success: false, attempted: false, message: '' }
  }

  let recoveredPassphrase = ''
  try {
    recoveredPassphrase = await quickUnlock.recoverPassphrase({ mode, accountId: normalizedAccountId })
  } catch (error) {
    if (quickUnlock.shouldForgetRecordOnError(error)) {
      removeQuickUnlockRecord(mode, normalizedAccountId)
    }
    return {
      success: false,
      attempted: true,
      cancelled: quickUnlock.isCancellationError(error),
      message: quickUnlock.isCancellationError(error)
        ? 'Quick unlock was cancelled.'
        : 'Saved passphrase could not be used. Enter passphrase manually.'
    }
  }

  if (!recoveredPassphrase) {
    return {
      success: false,
      attempted: true,
      message: 'Saved passphrase could not be used. Enter passphrase manually.'
    }
  }

  try {
    const success = mode === 'remote'
      ? await unlockRemote({
        passphrase: recoveredPassphrase,
        username: options.username || normalizedAccountId,
        password: options.password || '',
        trustSession: !!options.trustSession
      })
      : await unlockLocal(recoveredPassphrase)

    if (!success) {
      removeQuickUnlockRecord(mode, normalizedAccountId)
      return {
        success: false,
        attempted: true,
        message: 'Saved passphrase was rejected. Enter passphrase manually.'
      }
    }

    return {
      success: true,
      attempted: true,
      passphrase: recoveredPassphrase
    }
  } catch (error) {
    if (!quickUnlock.isCancellationError(error)
      && (quickUnlock.shouldForgetRecordOnError(error) || shouldForgetQuickUnlockFromUnlockError(error))) {
      removeQuickUnlockRecord(mode, normalizedAccountId)
    }
    return {
      success: false,
      attempted: true,
      cancelled: quickUnlock.isCancellationError(error),
      message: quickUnlock.isCancellationError(error)
        ? 'Quick unlock was cancelled.'
        : String(error?.message || 'Saved passphrase could not be used. Enter passphrase manually.')
    }
  }
}

async function unlockLocal(code) {
  const { salt, data } = localEncryptedData.get()

  if (data) {
    if (!salt) {
      log('Invalid encrypted data format, missing salt')
      return false
    }
  }
  else {
    log('No encrypted data found in localStorage, starting with empty doc')
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

async function unlockRemote({ passphrase: code, username, password, trustSession }) {
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
    throw new Error('Could not validate remote session. Please sign in again.')
  }
  if (user.email) {
    store.user.set(user.email)
  }

  const remoteData = await remoteSync.read()
  if (!remoteData?.data) {
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

let introVmdCache = null

async function getIntroVmdText() {
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
      if (err?.name === 'AbortError') throw new Error('No file selected.')
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

async function unlock(code, options = {}) {
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
  isQuickUnlockSupported: () => quickUnlock.isSupported(),
  hasSavedQuickUnlock(options = {}) {
    const mode = options.mode === 'remote' ? 'remote' : 'local'
    const accountId = mode === 'remote'
      ? normalizeAccountId(options.accountId || options.username)
      : ''
    return quickUnlock.hasSavedPassphrase({ mode, accountId })
  },
  getPassphrase: () => passphrase.value,
  async saveQuickUnlock(options = {}) {
    const mode = options.mode === 'remote' ? 'remote' : 'local'
    const accountId = mode === 'remote'
      ? resolveRemoteAccountId({ fallback: options.accountId || options.username })
      : ''
    await quickUnlock.savePassphrase({
      mode,
      accountId,
      passphrase: options.passphrase || passphrase.value
    })
  },
  removeQuickUnlock(options = {}) {
    const mode = options.mode === 'remote' ? 'remote' : 'local'
    const accountId = mode === 'remote'
      ? resolveRemoteAccountId({ fallback: options.accountId || options.username })
      : ''
    removeQuickUnlockRecord(mode, accountId)
  },
  unlockWithSavedQuickUnlock,
  async tryQuickUnlockStartup(options = {}) {
    if (!quickUnlock.isSupported()) {
      return { success: false, attempted: false, message: '' }
    }

    const mode = options.mode || 'local'
    if (mode === 'local') {
      return unlockWithSavedQuickUnlock({ mode: 'local' })
    }

    if (mode === 'remote' && options.scenario === 'remote-session-valid') {
      const accountId = resolveRemoteAccountId({ user: options.user, fallback: options.lastUsername })
      return unlockWithSavedQuickUnlock({
        mode: 'remote',
        accountId,
        username: accountId,
        trustSession: true
      })
    }

    return { success: false, attempted: false, message: '' }
  },
  getLastUsername: () => store.user.get('') || '',
  getPreferredMode: () => normalizeMode(store.mode.get(null)),
  setPreferredMode(mode) {
    rememberMode(mode)
  },
  hasSupabase: () => !!window.supabase?.createClient,
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
    const hasSupabase = !!window.supabase?.createClient
    const hasFilesystem = filesystemStorage.isSupported()
    const quickUnlockSupported = quickUnlock.isSupported()
    const quickUnlockLocalSaved = quickUnlock.hasSavedPassphrase({ mode: 'local' })
    const hasSavedFileHandle = hasFilesystem ? await filesystemStorage.hasSavedHandle() : false
    const lastUsername = store.user.get('') || ''
    const preferredMode = normalizeMode(store.mode.get(null))
    let user = null
    let hasRemoteData = false

    if (hasSupabase) {
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

    const quickUnlockRemoteSaved = quickUnlock.hasSavedPassphrase({
      mode: 'remote',
      accountId: resolveRemoteAccountId({ user, fallback: lastUsername })
    })

    const bootstrapBase = {
      hasLocalData,
      hasSupabase,
      hasFilesystem,
      hasSavedFileHandle,
      lastUsername,
      preferredMode,
      quickUnlockSupported,
      quickUnlockLocalSaved,
      quickUnlockRemoteSaved
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
    removeQuickUnlockRecord('local')
  },
  async signUp(email, password) {
    const res = await remoteSync.signUp(email.trim(), password)
    store.user.set(email.trim())
    rememberMode('remote')
    return res
  },
  async resetRemoteData(newPassphrase, options = {}) {
    const username = (options.username || '').trim()
    const password = options.password || ''
    if (!newPassphrase) {
      throw new Error('Enter a new passphrase before resetting remote data.')
    }
    let user = await this.getUser()
    if (!user && username && password) {
      await remoteSync.signIn(username, password)
      store.user.set(username)
      user = await this.getUser()
    }
    if (!user) {
      throw new Error('Could not validate remote session. Sign in again before resetting data.')
    }

    const remoteAccountId = resolveRemoteAccountId({ user, fallback: username })
    removeQuickUnlockRecord('remote', remoteAccountId)

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
    clearCredentials()
    passphrase.value = ''
    filesystemReady.value = false
    memoryReady.value = false
  },
  async signOut() {
    stopPolling()
    clearCredentials()
    await remoteSync.signOut()
    authMode.value = 'remote'
    passphrase.value = ''
    filesystemReady.value = false
    rememberMode('remote')
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
    quickUnlock.clearAllSavedPassphrases()
    filesystemStorage.clear()
  },
  unlock
}
