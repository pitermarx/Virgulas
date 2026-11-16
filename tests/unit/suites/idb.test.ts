import { describe, it, beforeEach } from 'bun:test'
import { idbStore } from '../../../source/js/idb.js'
import { installFakeIndexedDB } from '../indexedDbFake.js'
import { assertEqual } from '../testing.js'

beforeEach(() => installFakeIndexedDB())

describe('idbStore', () => {

    it('round-trips values and deletes them', async () => {
        const kv = idbStore('test-db', 'kv')
        assertEqual(await kv.get('missing'), null, 'a missing key reads null')

        await kv.put('key', { value: 42 })
        assertEqual((await kv.get<any>('key'))?.value, 42, 'the value round-trips')

        await kv.delete('key')
        assertEqual(await kv.get('key'), null, 'a deleted key reads null')
    })

    it('keeps object stores independent', async () => {
        const first = idbStore('test-db', 'first')
        const second = idbStore('test-db', 'second')
        await first.put('key', 'first-value')
        assertEqual(await second.get('key'), null, 'the other store does not see it')
    })

    it('opens a fresh database after the global is replaced', async () => {
        await idbStore('fresh-db', 'kv').put('key', 'value')
        installFakeIndexedDB()
        assertEqual(await idbStore('fresh-db', 'kv').get('key'), null, 'the cached connection was dropped')
    })
})
