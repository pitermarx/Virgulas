import { signal } from '@preact/signals'
import { detectBrowserCapabilities } from './utils.js'
import { idbStore } from './idb.js'
import { fromBase64, toBase64 } from './crypto2.js'

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

const store = idbStore(IDB_NAME, IDB_STORE)

/** Whether this device holds a sealed passphrase (reactive mirror of the store). */
const enrolled = signal(false)

// Only the base64 serialization helpers are shared with crypto2; the seal's
// own AES-GCM wrap stays local (the Rule 7 exception for this module).

async function generateAesKey() {
  return window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: key material never leaves the crypto subsystem
    ['encrypt', 'decrypt']
  )
}

async function wrapPassphrase(passphrase: string, key: CryptoKey) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(passphrase)
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return toBase64(combined)
}

async function unwrapPassphrase(wrapped: string, key: CryptoKey) {
  const combined = fromBase64(wrapped)
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

export const biometrics = {
  /** The device's seal state, so the lock screen and Options read one signal. */
  enrolled,
  isSupported: () => {
    if (typeof window === 'undefined') return false
    const capabilities = detectBrowserCapabilities()
    return capabilities.cryptoSubtle &&
      capabilities.indexedDB &&
      !!window.PublicKeyCredential &&
      typeof navigator.credentials?.create === 'function' &&
      typeof navigator.credentials?.get === 'function'
  },

  async hasEnrolled() {
    try {
      enrolled.value = !!(await store.get(KEY_CREDENTIAL))
      return enrolled.value
    } catch {
      enrolled.value = false
      return false
    }
  },

  async enroll(passphrase: string, userLabel = 'Virgulas user') {
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

    const storedCredential = { id: toBase64(new Uint8Array((credential as PublicKeyCredential).rawId)) }

    // 2. Wrap the passphrase with a fresh non-extractable key
    const aesKey = await generateAesKey()
    const wrapped = await wrapPassphrase(passphrase, aesKey)

    // 3. Persist
    await store.put(KEY_CREDENTIAL, storedCredential)
    await store.put(KEY_AES, aesKey)
    await store.put(KEY_WRAPPED, wrapped)
    enrolled.value = true

    return true
  },

  async unlock() {
    if (!this.isSupported()) return null
    try {
      const credential = await store.get<any>(KEY_CREDENTIAL)
      if (!credential) return null

      const challenge = window.crypto.getRandomValues(new Uint8Array(32))
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: fromBase64(credential.id), type: 'public-key' }],
          userVerification: 'required',
          timeout: 120000
        }
      })
      if (!assertion) return null

      const aesKey = await store.get<CryptoKey>(KEY_AES)
      const wrapped = await store.get<string>(KEY_WRAPPED)
      if (!aesKey || !wrapped) return null

      return await unwrapPassphrase(wrapped, aesKey)
    } catch {
      return null
    }
  },

  async forget() {
    await store.delete(KEY_CREDENTIAL)
    await store.delete(KEY_AES)
    await store.delete(KEY_WRAPPED)
    enrolled.value = false
  }
}
