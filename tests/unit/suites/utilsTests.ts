import { detectBrowserCapabilities, isMobile, store, supportsEncryptedStorage } from '../../../source/js/utils.js'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

section('store slots')

await test('round-trips a string value', () => {
    store.theme.set('dark')
    assertEqual(store.theme.get('light'), 'dark', 'stored value wins over fallback')
})

await test('get returns the fallback for a missing key', () => {
    store.theme.del()
    assertEqual(store.theme.get('light'), 'light', 'fallback returned')
    assertEqual(store.theme.get(null), null, 'null fallback')
})

await test('set(null) removes the key', () => {
    store.theme.set('dark')
    store.theme.set(null)
    assertEqual(store.theme.get('fallback'), 'fallback', 'null removes')
})

await test('every documented slot round-trips', () => {
    store.mode.set('remote')
    store.user.set('user@example.com')
    store.syncTs.set('12345')
    store.scheduledWindow.set('7')
    store.inboxNodeName.set('Inbox')
    store.inboxQueue.set('[]')

    assertEqual(store.mode.get(), 'remote', 'mode')
    assertEqual(store.user.get(), 'user@example.com', 'user')
    assertEqual(store.syncTs.get(), '12345', 'syncTs')
    assertEqual(store.scheduledWindow.get(), '7', 'scheduledWindow')
    assertEqual(store.inboxNodeName.get(), 'Inbox', 'inboxNodeName')
    assertEqual(store.inboxQueue.get(), '[]', 'inboxQueue')
})

await test('isMobile is a boolean derived from the user agent', () => {
    assertEqual(typeof isMobile, 'boolean', 'isMobile boolean')
})

section('browser capabilities')

const completeBrowserApis = {
    crypto: { subtle: {} },
    CompressionStream: () => null,
    DecompressionStream: () => null,
    localStorage: {},
    indexedDB: {}
}

await test('detects APIs needed by encrypted storage', () => {
    const capabilities = detectBrowserCapabilities(completeBrowserApis)
    assert(capabilities.cryptoSubtle, 'Web Crypto should be available')
    assert(capabilities.compressionStreams, 'Both compression stream APIs should be available')
    assert(capabilities.localStorage, 'localStorage should be available')
    assert(supportsEncryptedStorage(capabilities), 'Encrypted storage should be available')
})

await test('requires both compression directions for encrypted storage', () => {
    const capabilities = detectBrowserCapabilities({ ...completeBrowserApis, DecompressionStream: undefined })
    assert(!capabilities.compressionStreams, 'A missing decompression API should be detected')
    assert(!supportsEncryptedStorage(capabilities), 'Encrypted storage should be unavailable')
})

await test('requires Web Crypto for encrypted storage', () => {
    const capabilities = detectBrowserCapabilities({ ...completeBrowserApis, crypto: { subtle: undefined } })
    assert(!capabilities.cryptoSubtle, 'A missing crypto.subtle API should be detected')
    assert(!supportsEncryptedStorage(capabilities), 'Encrypted storage should be unavailable')
})

await test('IndexedDB is independent from encrypted storage requirements', () => {
    const capabilities = detectBrowserCapabilities({ ...completeBrowserApis, indexedDB: undefined })
    assert(!capabilities.indexedDB, 'A missing IndexedDB API should be detected')
    assert(supportsEncryptedStorage(capabilities), 'Encrypted storage should not require IndexedDB')
})

await test('detects a localStorage getter that throws', () => {
    const apis = { ...completeBrowserApis }
    Object.defineProperty(apis, 'localStorage', { get: () => { throw new Error('blocked') } })
    const capabilities = detectBrowserCapabilities(apis)
    assert(!capabilities.localStorage, 'Unavailable localStorage should be detected')
    assert(!supportsEncryptedStorage(capabilities), 'Encrypted storage should be unavailable')
})
