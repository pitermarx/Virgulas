// Biometric (WebAuthn) unlock for Virgulas.
//
// Stores the encryption passphrase encrypted at rest on this device:
//   - The passphrase is stored AES-GCM-encrypted with a non-extractable key that
//     lives only in IndexedDB (its raw bytes are never exposed to JavaScript).
//   - The app releases it only after a successful WebAuthn user-verification
//     ceremony (fingerprint / face / device PIN).
//
// NOTE: this is an application-level convenience gate, not a cryptographic
// requirement. The non-extractable AES key is readable by any same-origin script,
// which could call crypto.subtle.decrypt directly and bypass the biometric prompt.
// Enforcing true hardware-key binding would require the WebAuthn PRF extension.
//
// Nothing is ever sent to the server; the server continues to see only ciphertext.

const IDB_NAME = 'virgulas-biometric'
const IDB_STORE = 'kv'
const KEY_CREDENTIAL = 'credential'
const KEY_AES = 'aes-key'
const KEY_WRAPPED = 'wrapped-passphrase'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function kvGet(key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function kvSet(key, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function kvDelete(key) {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(key)
    tx.oncomplete = () => resolve()
  })
}

const b64 = {
  encode(buf) {
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  },
  decode(str) {
    const s = atob(str)
    const bytes = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
    return bytes.buffer
  }
}

async function generateAesKey() {
  return window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: key material never leaves the crypto subsystem
    ['encrypt', 'decrypt']
  )
}

async function wrapPassphrase(passphrase, key) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(passphrase)
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return b64.encode(combined)
}

async function unwrapPassphrase(wrapped, key) {
  const combined = new Uint8Array(b64.decode(wrapped))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

export const biometrics = {
  isSupported: () =>
    typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function',

  async hasEnrolled() {
    try {
      return !!(await kvGet(KEY_CREDENTIAL))
    } catch {
      return false
    }
  },

  async enroll(passphrase, userLabel = 'Virgulas user') {
    if (!this.isSupported()) {
      throw new Error('Biometric unlock is not supported in this browser.')
    }
    if (!passphrase) {
      throw new Error('A passphrase is required to enable biometric unlock.')
    }

    // 1. Register the passkey with hardware-backed user verification
    const userHandle = window.crypto.getRandomValues(new Uint8Array(16))
    const challenge = window.crypto.getRandomValues(new Uint8Array(32))
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Virgulas' },
        user: { id: userHandle, name: userLabel, displayName: userLabel },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        timeout: 120000
      }
    })

    const storedCredential = { id: b64.encode(credential.rawId) }

    // 2. Wrap the passphrase with a fresh non-extractable key
    const aesKey = await generateAesKey()
    const wrapped = await wrapPassphrase(passphrase, aesKey)

    // 3. Persist
    await kvSet(KEY_CREDENTIAL, storedCredential)
    await kvSet(KEY_AES, aesKey)
    await kvSet(KEY_WRAPPED, wrapped)

    return true
  },

  async unlock() {
    if (!this.isSupported()) return null
    try {
      const credential = await kvGet(KEY_CREDENTIAL)
      if (!credential) return null

      const challenge = window.crypto.getRandomValues(new Uint8Array(32))
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: b64.decode(credential.id), type: 'public-key' }],
          userVerification: 'required',
          timeout: 120000
        }
      })
      if (!assertion) return null

      const aesKey = await kvGet(KEY_AES)
      const wrapped = await kvGet(KEY_WRAPPED)
      if (!aesKey || !wrapped) return null

      return await unwrapPassphrase(wrapped, aesKey)
    } catch {
      return null
    }
  },

  async forget() {
    await kvDelete(KEY_CREDENTIAL)
    await kvDelete(KEY_AES)
    await kvDelete(KEY_WRAPPED)
  }
}
