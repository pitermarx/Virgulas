import { describe, it } from 'bun:test'
import { describeBrowserSupport, isEncryptedMode, modeLabel, modes, normalizeMode } from '../../../source/js/modes.js'
import type { BrowserCapabilities } from '../../../source/js/utils.js'
import { assert, assertEqual } from '../testing.js'

// One owner for the four modes' UI traits and copy. Behavioural branches stay in
// their modules; these values are what the toolbar, lock screen and Options read.

describe('storage mode table', () => {

  it('covers exactly the four modes with stable labels', () => {
      assertEqual(Object.keys(modes).sort().join(','), 'filesystem,local,memory,remote', 'four modes')
      assertEqual(modeLabel('memory'), 'Memory', 'memory label')
      assertEqual(modeLabel('local'), 'Local', 'local label')
      assertEqual(modeLabel('remote'), 'Remote', 'remote label')
      assertEqual(modeLabel('filesystem'), 'File', 'file label')
  })

  it('only Local and Remote carry a passphrase', () => {
      assert(isEncryptedMode('local'), 'local is encrypted')
      assert(isEncryptedMode('remote'), 'remote is encrypted')
      assert(!isEncryptedMode('memory'), 'memory is not encrypted')
      assert(!isEncryptedMode('filesystem'), 'file is not encrypted')
  })

  it('only Remote leaves this device', () => {
      assert(modes.remote.synced, 'remote is synced')
      for (const mode of ['memory', 'local', 'filesystem'] as const) {
          assert(!modes[mode].synced, `${mode} stays on the device`)
      }
  })

  it('the Options summary says how the copy is stored', () => {
      assertEqual(modes.local.detail, ' · encrypted', 'local detail')
      assertEqual(modes.remote.detail, ' · encrypted', 'remote detail')
      assertEqual(modes.filesystem.detail, ' · not encrypted', 'file detail')
      assertEqual(modes.memory.detail, ' · in-memory only', 'memory detail')
  })

  it('the danger copy matches what each mode loses', () => {
      assertEqual(modes.remote.action, 'Sign out', 'remote action')
      assert(modes.remote.prompt.includes('server is unaffected'), 'remote keeps the server copy')
      assertEqual(modes.filesystem.action, 'Clear file session', 'file action')
      assert(modes.filesystem.prompt.includes('.vmd file on disk is unaffected'), 'file keeps the disk copy')
      assertEqual(modes.local.action, 'Delete local data', 'local action')
      assert(modes.local.prompt.includes('cannot be undone'), 'local data is gone')
      assertEqual(modes.memory.action, 'Delete local data', 'memory action')
  })

  it('normalizes only the four stored mode values', () => {
      assertEqual(normalizeMode('local'), 'local', 'local')
      assertEqual(normalizeMode('remote'), 'remote', 'remote')
      assertEqual(normalizeMode('filesystem'), 'filesystem', 'file')
      assertEqual(normalizeMode('memory'), 'memory', 'memory')
      assertEqual(normalizeMode('nonsense'), null, 'unknown mode')
      assertEqual(normalizeMode(null), null, 'no stored mode')
  })

  it('warns about the APIs a mode needs', () => {
      const all: BrowserCapabilities = { cryptoSubtle: true, compressionStreams: true, localStorage: true, indexedDB: true }
      assertEqual(describeBrowserSupport(all, true), '', 'no warning when everything is available')
      assert(describeBrowserSupport({ ...all, cryptoSubtle: false }, false).includes('Web Crypto'), 'names the missing crypto')
      assert(describeBrowserSupport({ ...all, indexedDB: false }, true).includes('IndexedDB'), 'names the missing IndexedDB')
  })
})
