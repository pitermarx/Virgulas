import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert } from '../testing.js'

// docs/storage-interface.md §4.3: KeySession is the single retention point for
// the session passphrase. Orchestration may mirror its lock state as a boolean,
// but must never keep the string, and the lock screen drops its form copy once
// the unlock succeeds.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

describe('passphrase retention', () => {

  it('persistence keeps the passphrase in KeySession only', () => {
      const src = read('source/js/persistence.ts')
      assert(
          !/const passphrase\s*=\s*signal/.test(src),
          'persistence must not declare a plaintext passphrase signal'
      )
      assert(
          !/passphrase\.value\s*=/.test(src),
          'persistence must not assign a plaintext passphrase signal'
      )
      assert(
          /sessionUnlocked\.value\s*=\s*keySession\.unlocked/.test(src),
          'the reactive session flag must mirror keySession.unlocked'
      )
      assert(
          /keySession\.activeCredentials\(\)\?\.passphrase/.test(src),
          'biometric enrollment must read the active credentials from KeySession'
      )
  })

  it('the key session drops derived keys on lock and on rotation', () => {
      const crypto = read('source/js/crypto2.ts')
      assert(
          /export function clearKeyCache\(\)/.test(crypto),
          'crypto2 must expose clearKeyCache() for the session'
      )
      const store = read('source/js/encryptedStore.ts')
      const rotateBody = store.slice(
          store.indexOf('rotate(newPassphrase: string) {'),
          store.indexOf('lock() {', store.indexOf('rotate(newPassphrase: string) {'))
      )
      assert(rotateBody.length > 0, 'the KeySession rotate body must be found')
      assert(
          /clearKeyCache\(\)/.test(rotateBody),
          'rotate() must drop the keys the cache holds under the previous passphrase'
      )
      const lockBody = store.slice(
          store.indexOf('lock() {'),
          store.indexOf('activeCredentials() {', store.indexOf('lock() {'))
      )
      assert(lockBody.length > 0, 'the KeySession lock body must be found')
      assert(
          /clearKeyCache\(\)/.test(lockBody),
          'lock() must drop the derived keys the cache retains under the passphrase'
      )
  })

  it('the lock screen drops its form copy after a successful unlock', () => {
      const src = read('source/js/app.ts')
      assert(
          !/passphrase\.value\s*=\s*recovered/.test(src),
          'biometric unlock must not mirror the recovered passphrase into the form'
      )

      const submitUnlock = src.slice(
          src.indexOf('async function submitUnlock'),
          src.indexOf('async function submitSignUp')
      )
      assert(
          /if \(success\) \{[\s\S]*?passphrase\.value = '';/.test(submitUnlock),
          'submitUnlock must clear the form copy on success'
      )

      const resetLocal = src.slice(
          src.indexOf('async function submitResetLocalData'),
          src.indexOf('async function submitResetRemoteData')
      )
      assert(
          /if \(success\) \{[\s\S]*?passphrase\.value = '';/.test(resetLocal),
          'submitResetLocalData must clear the form copy on success'
      )

      const resetRemote = src.slice(
          src.indexOf('async function submitResetRemoteData'),
          src.indexOf('async function continueInMemory')
      )
      assert(
          /await persistence\.resetRemoteData\([\s\S]*?passphrase\.value = '';/.test(resetRemote),
          'submitResetRemoteData must clear the form copy on success'
      )
  })
})
