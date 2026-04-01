import { signal, effect, batch } from '@preact/signals'
import * as cryptoFn from "./crypto2.js"
import outline from "./outline.js"
import { log } from './utils.js'

window.remoteSync = (function () {
  // this may get replaced with another config for tests
  const config = { url: 'https://gcpdascpdrakecpknrtt.supabase.co', key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc' }
  const client = window.supabase.createClient(config.url, config.key)
  const mainTable = client.from('outlines')

  async function withClient(fn) {
    const { data, error } = await fn(client)
    // PTGRST116 = No rows found, which is expected if the user hasn't saved anything yet
    if (error && error.code !== 'PGRST116') throw error
    return data
  }

  const module = {
    withClient,
    signIn: (email, password) => withClient((c) => c.auth.signInWithPassword({ email, password })),
    signUp: (email, password) => withClient((c) => c.auth.signUp({ email, password })),
    signOut: () => client.auth.signOut(),
    getUser: () => withClient((c) => c.auth.getUser()).then(res => res.user),

    read: () => withClient(() => mainTable.select('data, updated_at').single()),
    getLastUpdate: () => withClient(() => mainTable.select('updated_at').single()),
    upsert: async (data) => {
      return await withClient(() => mainTable
        .upsert({
          //user_id: user.id,
          data,
          updated_at: new Date().toISOString()
        }, {
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


let lastTimeoutId = null
effect(() => {
  const version = outline.version.value // subscribe to changes on doc
  const passphraseValue = passphrase.value // subscribe to changes on passphrase
  if (!passphraseValue) {
    log('No passphrase, skipping encryption')
    return
  }

  let saltValue = localEncryptedData.get().salt
  if (!saltValue) {
    log('No salt found, creating new salt for encryption')
    saltValue = cryptoFn.generateSalt()
  }

  let timeoutId = lastTimeoutId = setTimeout(async () => {
    try {
      log('[Persistence] Compressing and encrypting doc v' + version + '...')
      const json = outline.serialize() // get latest doc state
      if (lastTimeoutId !== timeoutId) {
        log('[Persistence] Newer encryption in progress, skipping this one')
        return
      }
      const encrypted = await cryptoFn.encrypt(json, passphraseValue, saltValue)
      if (lastTimeoutId !== timeoutId) {
        log('[Persistence] Newer encryption in progress, skipping this one')
        return
      }
      localEncryptedData.set(encrypted, saltValue)
      log('[Persistence] Saved encrypted doc v' + version + ' length=', encrypted.length)
    } catch (error) {
      console.error('[Persistence] Error encrypting doc v' + version + ':', error)
    }
  }, 1000) // debounce encryption by 1 second

  return () => clearTimeout(timeoutId)
})

async function unlock(code) {
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
    passphrase.value = code
    return true
  }

  try {
    const json = await cryptoFn.decrypt(data, code, salt)

    batch(() => {
      passphrase.value = code
      outline.deserialize(json)
      const hash = window.location.hash.slice(1)
      if (hash) {
        const node = outline.get(hash).peek()
        if (node) {
          outline.zoomIn(hash)
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

export default {
  hasData: () => !!localEncryptedData.get().data,
  isLocked: () => !passphrase.value,
  lock: () => passphrase.value = '',
  reset() {
    outline.reset()
    localEncryptedData.set(null, null)
    passphrase.value = ''
  },
  unlock
}
