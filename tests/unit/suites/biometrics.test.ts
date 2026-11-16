import { describe, it } from 'bun:test'
import { biometrics } from '../../../source/js/biometrics.js'
import { assertEqual } from '../testing.js'
import { installFakeIndexedDB } from '../indexedDbFake.js'

// ─── WebAuthn / crypto stubs ─────────────────────────────────────────────────

function ensureWindowCrypto() {
    if (!(window as any).crypto?.subtle) {
        Object.defineProperty(window, 'crypto', { configurable: true, value: globalThis.crypto })
    }
}

function enableWebAuthn() {
    ensureWindowCrypto()
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class { } })
    const rawId = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer
    Object.defineProperty(navigator, 'credentials', {
        configurable: true,
        value: {
            create: async () => ({ rawId, id: 'credential-1' }),
            get: async () => ({ rawId, id: 'credential-1' })
        }
    })
}

function disableWebAuthn() {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {} })
}


describe('biometrics support detection', () => {

  it('isSupported follows WebAuthn availability', () => {
      disableWebAuthn()
      assertEqual(biometrics.isSupported(), false, 'unsupported without PublicKeyCredential')
      installFakeIndexedDB()
      enableWebAuthn()
      assertEqual(biometrics.isSupported(), true, 'supported with create/get helpers')
  })

  it('isSupported is false without IndexedDB', () => {
      const indexedDB = (globalThis as any).indexedDB
          ; (globalThis as any).indexedDB = undefined
      enableWebAuthn()
      assertEqual(biometrics.isSupported(), false, 'unsupported without IndexedDB')
          ; (globalThis as any).indexedDB = indexedDB
  })

  it('enroll rejects when WebAuthn is unsupported', async () => {
      disableWebAuthn()
      let message = ''
      try {
          await biometrics.enroll('secret')
      } catch (error) {
          message = (error as Error).message
      }
      assertEqual(message, 'Biometric unlock is not supported in this browser.', 'unsupported message')
  })

  it('unlock returns null when WebAuthn is unsupported', async () => {
      disableWebAuthn()
      assertEqual(await biometrics.unlock(), null, 'null result')
  })
})

describe('biometric enroll / unlock', () => {

  it('rejects an empty passphrase', async () => {
      installFakeIndexedDB()
      enableWebAuthn()
      let message = ''
      try {
          await biometrics.enroll('')
      } catch (error) {
          message = (error as Error).message
      }
      assertEqual(message, 'A passphrase is required to enable biometric unlock.', 'empty passphrase message')
  })

  it('enroll stores a wrapped passphrase that unlock recovers', async () => {
      installFakeIndexedDB()
      enableWebAuthn()
      await biometrics.forget().catch(() => { })

      assertEqual(await biometrics.hasEnrolled(), false, 'starts unenrolled')
      await biometrics.enroll('correct-horse-battery', 'Tester')
      assertEqual(await biometrics.hasEnrolled(), true, 'enrolled')
      assertEqual(await biometrics.unlock(), 'correct-horse-battery', 'passphrase recovered')
  })

  it('forget removes the stored credential and wrapped passphrase', async () => {
      installFakeIndexedDB()
      enableWebAuthn()
      await biometrics.enroll('to-be-forgotten', 'Tester')
      assertEqual(await biometrics.hasEnrolled(), true, 'enrolled first')

      await biometrics.forget()
      assertEqual(await biometrics.hasEnrolled(), false, 'credential removed')
      assertEqual(await biometrics.unlock(), null, 'unlock returns null after forget')
  })

  it('unlock returns null when no credential is stored', async () => {
      installFakeIndexedDB()
      enableWebAuthn()
      await biometrics.forget().catch(() => { })
      assertEqual(await biometrics.unlock(), null, 'nothing to unlock')
  })

  it('hasEnrolled is false when IndexedDB is unavailable', async () => {
      ; (globalThis as any).indexedDB = undefined
      assertEqual(await biometrics.hasEnrolled(), false, 'graceful on missing IndexedDB')
      installFakeIndexedDB()
  })
})