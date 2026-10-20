import { describe, it } from 'bun:test'
import {
    clearAppCaches,
    detectBrowserCapabilities,
    isMobile,
    isStoragePersistent,
    requestPersistentStorage,
    store,
    supportsEncryptedStorage
} from '../../../source/js/utils.js'
import { assert, assertEqual } from '../testing.js'

const completeBrowserApis = {
    crypto: { subtle: {} },
    CompressionStream: () => null,
    DecompressionStream: () => null,
    localStorage: {},
    indexedDB: {}
}
function fakeCacheStorage(names: string[]) {
    const deleted: string[] = []
    const storage = {
        async keys() { return names.slice() },
        async delete(name: string) { deleted.push(name); return true }
    }
    return { storage, deleted }
}

describe('store slots', () => {

  it('round-trips a string value', () => {
      store.theme.set('dark')
      assertEqual(store.theme.get('light'), 'dark', 'stored value wins over fallback')
  })

  it('get returns the fallback for a missing key', () => {
      store.theme.del()
      assertEqual(store.theme.get('light'), 'light', 'fallback returned')
      assertEqual(store.theme.get(null), null, 'null fallback')
  })

  it('set(null) removes the key', () => {
      store.theme.set('dark')
      store.theme.set(null)
      assertEqual(store.theme.get('fallback'), 'fallback', 'null removes')
  })

  it('every documented slot round-trips', () => {
      store.mode.set('remote')
      store.user.set('user@example.com')
      store.syncTs.set('12345')
      store.scheduledWindow.set('7')
      store.inboxNodeName.set('Inbox')
      store.inboxQueue.set('[]')
      store.storageNoticeDismissed.set('1')

      assertEqual(store.mode.get(), 'remote', 'mode')
      assertEqual(store.user.get(), 'user@example.com', 'user')
      assertEqual(store.syncTs.get(), '12345', 'syncTs')
      assertEqual(store.scheduledWindow.get(), '7', 'scheduledWindow')
      assertEqual(store.inboxNodeName.get(), 'Inbox', 'inboxNodeName')
      assertEqual(store.inboxQueue.get(), '[]', 'inboxQueue')
      assertEqual(store.storageNoticeDismissed.get(), '1', 'storageNoticeDismissed')
  })

  it('isMobile is a boolean derived from the user agent', () => {
      assertEqual(typeof isMobile, 'boolean', 'isMobile boolean')
  })
})

describe('browser capabilities', () => {


  it('detects APIs needed by encrypted storage', () => {
      const capabilities = detectBrowserCapabilities(completeBrowserApis)
      assert(capabilities.cryptoSubtle, 'Web Crypto should be available')
      assert(capabilities.compressionStreams, 'Both compression stream APIs should be available')
      assert(capabilities.localStorage, 'localStorage should be available')
      assert(supportsEncryptedStorage(capabilities), 'Encrypted storage should be available')
  })

  it('requires both compression directions for encrypted storage', () => {
      const capabilities = detectBrowserCapabilities({ ...completeBrowserApis, DecompressionStream: undefined })
      assert(!capabilities.compressionStreams, 'A missing decompression API should be detected')
      assert(!supportsEncryptedStorage(capabilities), 'Encrypted storage should be unavailable')
  })

  it('requires Web Crypto for encrypted storage', () => {
      const capabilities = detectBrowserCapabilities({ ...completeBrowserApis, crypto: { subtle: undefined } })
      assert(!capabilities.cryptoSubtle, 'A missing crypto.subtle API should be detected')
      assert(!supportsEncryptedStorage(capabilities), 'Encrypted storage should be unavailable')
  })

  it('IndexedDB is independent from encrypted storage requirements', () => {
      const capabilities = detectBrowserCapabilities({ ...completeBrowserApis, indexedDB: undefined })
      assert(!capabilities.indexedDB, 'A missing IndexedDB API should be detected')
      assert(supportsEncryptedStorage(capabilities), 'Encrypted storage should not require IndexedDB')
  })

  it('detects a localStorage getter that throws', () => {
      const apis = { ...completeBrowserApis }
      Object.defineProperty(apis, 'localStorage', { get: () => { throw new Error('blocked') } })
      const capabilities = detectBrowserCapabilities(apis)
      assert(!capabilities.localStorage, 'Unavailable localStorage should be detected')
      assert(!supportsEncryptedStorage(capabilities), 'Encrypted storage should be unavailable')
  })
})

describe('persistent storage', () => {

  it('recognizes existing persistent storage without requesting it again', async () => {
      let requests = 0
      const storage = {
          persisted: async () => true,
          persist: async () => { requests++; return false }
      }
      assert(await isStoragePersistent(storage), 'Existing persistent storage should be recognized')
      assert(await requestPersistentStorage(storage), 'Existing persistence should be retained')
      assertEqual(requests, 0, 'Already-persistent storage should not be requested again')
  })

  it('requests persistent storage when not already granted', async () => {
      let requests = 0
      const storage = {
          persisted: async () => false,
          persist: async () => { requests++; return true }
      }
      assert(await requestPersistentStorage(storage), 'Granted request should report persistent storage')
      assertEqual(requests, 1, 'Persistence should be requested once')
  })

  it('reports best-effort storage when persistence is denied or unavailable', async () => {
      const denied = { persisted: async () => false, persist: async () => false }
      assert(!await requestPersistentStorage(denied), 'Denied request should report best-effort storage')
      assert(!await requestPersistentStorage(null), 'Unavailable Storage API should report best-effort storage')
  })

  it('reports best-effort storage when the browser API throws', async () => {
      const storage = {
          persisted: async () => { throw new Error('storage unavailable') },
          persist: async () => true
      }
      assert(!await isStoragePersistent(storage), 'Failed status check should be best-effort')
      assert(!await requestPersistentStorage(storage), 'Failed request should be best-effort')
  })
})

describe('clearAppCaches', () => {


  it('deletes every virgulas-* cache', async () => {
      const { storage, deleted } = fakeCacheStorage([
          'virgulas-app-v111',
          'virgulas-fonts-v6',
          'virgulas-app-v99' // a stale version left by an older build
      ])
      await clearAppCaches(storage as unknown as CacheStorage)
      assertEqual(deleted.length, 3, 'all virgulas caches deleted')
      assert(deleted.includes('virgulas-app-v111'), 'current app cache deleted')
      assert(deleted.includes('virgulas-fonts-v6'), 'fonts cache deleted')
      assert(deleted.includes('virgulas-app-v99'), 'stale versioned cache deleted too')
  })

  it('leaves caches this app does not own untouched', async () => {
      const { storage, deleted } = fakeCacheStorage([
          'virgulas-app-v111',
          'other-origin-cache',
          'workbox-precache'
      ])
      await clearAppCaches(storage as unknown as CacheStorage)
      assertEqual(deleted.length, 1, 'only the virgulas cache is deleted')
      assertEqual(deleted[0], 'virgulas-app-v111', 'foreign caches are preserved')
  })

  it('no-ops when the Cache Storage API is unavailable', async () => {
      await clearAppCaches(undefined)
      // Resolves without throwing; nothing to assert beyond reaching here.
      assert(true, 'unavailable Cache Storage resolves cleanly')
  })

  it('never throws when the API rejects', async () => {
      const hostile = {
          async keys() { throw new Error('cache storage blocked') },
          async delete() { return true }
      }
      await clearAppCaches(hostile as unknown as CacheStorage)
      assert(true, 'a throwing Cache Storage API does not reject the purge')
  })
})