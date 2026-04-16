import { signal, effect, batch } from '@preact/signals'
import { encrypt, decrypt, randomId, generateSalt } from "./crypto2.js"
import outline from "./outline.js"
import { log } from './utils.js'

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

const remoteSync = (function () {
  const DEFAULT_CONFIG = { url: 'https://gcpdascpdrakecpknrtt.supabase.co', key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc' }
  let client = null
  let mainTable = null

  function readConfig() {
    try {
      const raw = localStorage.getItem('supabaseconfig')
      if (!raw) return DEFAULT_CONFIG
      const parsed = JSON.parse(raw)
      const url = parsed.url || parsed.supabaseUrl
      const key = parsed.key || parsed.supabaseAnonKey
      if (!url || !key) return DEFAULT_CONFIG
      return { url, key }
    } catch {
      return DEFAULT_CONFIG
    }
  }

  function ensureClient() {
    if (!window.supabase?.createClient) {
      throw new Error('Supabase client is unavailable in this environment')
    }
    if (client) return client
    const config = readConfig()
    client = window.supabase.createClient(config.url, config.key)
    mainTable = client.from('outlines')
    return client
  }

  async function withClient(fn) {
    const active = ensureClient()
    const { data, error } = await fn(active)
    // PTGRST116 = No rows found, which is expected if the user hasn't saved anything yet
    if (error && error.code !== 'PGRST116') throw error
    return data
  }

  const module = {
    withClient,
    signIn: (email, password) => withClient((c) => c.auth.signInWithPassword({ email, password })),
    signUp: (email, password) => withClient((c) => c.auth.signUp({ email, password })),
    signOut: async () => {
      const c = ensureClient()
      return c.auth.signOut()
    },
    getUser: () => withClient((c) => c.auth.getUser()).then(res => res.user),

    read: () => withClient(() => mainTable.select('salt, data, updated_at').single()),
    getLastUpdate: () => withClient(() => mainTable.select('updated_at').single()),
    upsert: async (data, salt) => {
      const payload = {
        data,
        updated_at: new Date().toISOString(),
        user_id: (await module.getUser())?.id
      }
      if (salt) {
        payload.salt = salt
      }
      return await withClient(() => mainTable
        .upsert(payload, {
          // this means "update the existing row with this user_id, or insert a new one if it doesn't exist"
          onConflict: 'user_id'
        }))
    }
  }

  return module
})()

const localEncryptedData = {
  get() {
    const v = localStorage.getItem('vmd_data_enc')
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
    localStorage.removeItem('vmd_data_enc')
  },
  set(value, salt) {
    if (value && salt) {
      localStorage.setItem('vmd_data_enc', salt + '|' + value)
    }
    else if (value || salt) {
      throw new Error('Both value and salt are required to set encrypted data')
    }
    else {
      localStorage.removeItem('vmd_data_enc')
    }
  }
}

const passphrase = signal('')
const authMode = signal('local')
const filesystemReady = signal(false)

let lastTimeoutId = null
effect(() => {
  const version = outline.version.value // subscribe to changes on doc
  const passphraseValue = passphrase.value // subscribe to changes on passphrase
  const fsReady = filesystemReady.value   // subscribe for filesystem mode
  const mode = authMode.value

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
      if (mode === 'remote') {
        try {
          await remoteSync.upsert(encrypted, saltValue)
        } catch (syncError) {
          console.error('[Persistence] Remote sync upload failed:', syncError)
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
    authMode.value = 'local'
    passphrase.value = code
    return true
  }

  try {
    const json = await decrypt(data, code, salt)

    batch(() => {
      authMode.value = 'local'
      passphrase.value = code
      outline.deserialize(json)
      const nodeParam = window.location.hash.replace('#', '')
      if (nodeParam) {
        const node = outline.get(nodeParam)
        if (node) {
          outline.zoomIn(nodeParam)
        }
      }
    })

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
    localStorage.setItem('vmd_last_username', username.trim())
  }

  const user = await remoteSync.getUser()
  if (!user) {
    throw new Error('Could not validate remote session. Please sign in again.')
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
    })
    localEncryptedData.set(remoteData.data, remoteSalt)
    return true
  } catch (error) {
    throw parseRemoteDecryptError(error)
  }
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
  } else {
    outline.reset()
    // Write initial empty doc to file
    await filesystemStorage.write(outline.getVMD('root'))
  }

  batch(() => {
    authMode.value = 'filesystem'
    filesystemReady.value = true
  })
  return true
}

async function unlock(code, options = {}) {
  const mode = options.mode || 'local'
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
  isLocked: () => !passphrase.value && !filesystemReady.value,
  hasFilesystem: () => filesystemStorage.isSupported(),
  getLastUsername: () => localStorage.getItem('vmd_last_username') || '',
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
    const lastUsername = localStorage.getItem('vmd_last_username') || ''
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

    if (user && hasRemoteData) return { mode: 'remote', scenario: 'remote-session-valid', hasLocalData, user, hasSupabase, hasFilesystem, lastUsername }
    if (hasLocalData) return { mode: 'local', scenario: 'local-present-no-session', hasLocalData, user: null, hasSupabase, hasFilesystem, lastUsername }
    if (lastUsername) return { mode: 'remote', scenario: 'remote-session-expired', hasLocalData, user: null, hasSupabase, hasFilesystem, lastUsername }
    return { mode: 'local', scenario: 'empty-local', hasLocalData, user: null, hasSupabase, hasFilesystem, lastUsername }
  },
  clearLocalData: () => localEncryptedData.set(null, null),
  async signUp(email, password) {
    const res = await remoteSync.signUp(email.trim(), password)
    localStorage.setItem('vmd_last_username', email.trim())
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
      localStorage.setItem('vmd_last_username', username)
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
    return true
  },
  lock() {
    passphrase.value = ''
    filesystemReady.value = false
  },
  async signOut() {
    await remoteSync.signOut()
    authMode.value = 'remote'
    passphrase.value = ''
    filesystemReady.value = false
  },
  async pickNewFile() {
    const text = await filesystemStorage.pickNewFile()
    if (text && text.trim()) {
      outline.reset()
      outline.setRootVMD(text)
    } else {
      outline.reset()
      await filesystemStorage.write(outline.getVMD('root'))
    }
  },
  reset() {
    outline.reset()
    localEncryptedData.set(null, null)
    authMode.value = 'local'
    passphrase.value = ''
    filesystemReady.value = false
    filesystemStorage.clear()
  },
  unlock
}
