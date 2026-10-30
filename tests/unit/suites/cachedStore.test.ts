import { describe, it } from 'bun:test'
// cached() decorator suite (docs/storage-interface.md §4.7/§10, rollout PR 2b):
// write order (cache before primary), primary network failure leaves the cache
// write standing and propagates, read falls back to cache only on network,
// exists-union, head is primary-only, cache quota failure attempts the primary
// and reports through onCacheWrite, unlock is primary-only, clear clears both.

import { cached } from '../../../source/js/cachedStore.js'
import { encrypted, createKeySession } from '../../../source/js/encryptedStore.js'
import { slotRaw } from '../../../source/js/localStore.js'
import { StoreError, type RawRecord, type RawStore, type StringStore } from '../../../source/js/storage.js'
import { assert, assertEqual } from '../testing.js'

// ─── fakes ───────────────────────────────────────────────────────────────────

interface FakeStringOptions {
    initial?: string | null
    writeError?: () => never
    readError?: () => never
}

function fakeStringStore(label: string, log: string[], options: FakeStringOptions = {}): StringStore {
    let value = options.initial ?? null
    return {
        async read() {
            log.push(`${label}:read`)
            if (options.readError) options.readError()
            return value
        },
        async write(text) {
            log.push(`${label}:write`)
            if (options.writeError) options.writeError()
            value = text
            return `${label}-token`
        },
        async clear() {
            log.push(`${label}:clear`)
            value = null
        },
        async exists() {
            log.push(`${label}:exists`)
            return value !== null
        },
        async head() {
            log.push(`${label}:head`)
            return value === null ? null : `${label}-token`
        },
        async unlock(passphrase: string) {
            log.push(`${label}:unlock`)
            return { text: value, headToken: value === null ? null : `${label}-token` }
        },
        async lock() {
            log.push(`${label}:lock`)
        },
        capabilities: { durable: 'always', encrypted: false, authenticated: false, changeDetection: true, available: true }
    }
}

function fakeRaw(): RawStore & { records: RawRecord[]; writes: RawRecord[] } {
    const records: RawRecord[] = []
    const writes: RawRecord[] = []
    return {
        records,
        writes,
        capabilities: { durable: 'always', encrypted: false, authenticated: false, changeDetection: true, available: true },
        async readRaw() { return records[0] ?? null },
        async writeRaw(record) { writes.push(record); records[0] = record; return `token-${writes.length}` },
        async clearRaw() { records.length = 0 },
        async exists() { return records.length > 0 },
        async head() { return records.length > 0 ? `token-${writes.length}` : null }
    }
}

async function expectStoreError(fn: () => Promise<unknown>, code: string, label: string): Promise<StoreError> {
    let threw: any = null
    try { await fn() } catch (e) { threw = e }
    assert(threw instanceof StoreError, `${label}: threw StoreError (got ${threw?.constructor?.name})`)
    assertEqual(threw.code, code, `${label}: code`)
    return threw
}

// ─── write order ────────────────────────────────────────────────────────────


describe('cached() — write', () => {

  it('cache is written first, then the primary; the primary token wins', async () => {
      const log: string[] = []
      const store = cached(fakeStringStore('primary', log), fakeStringStore('cache', log))
      const token = await store.write('document')
      assertEqual(token, 'primary-token', 'resolve with the primary token (§4.7)')
      assertEqual(log[0], 'cache:write', 'cache written first')
      assertEqual(log[1], 'primary:write', 'primary written second')
  })

  it('a primary network failure leaves the cache write standing and propagates', async () => {
      const log: string[] = []
      const primary = fakeStringStore('primary', log)
      const failing: StringStore = {
          ...primary,
          async write() { log.push('primary:write'); throw new StoreError('network', 'unreachable') }
      }
      const cache = fakeStringStore('cache', log, { initial: null })
      const store = cached(failing, cache)

      await expectStoreError(() => store.write('document'), 'network', 'primary failure')
      assertEqual(await (cache.read()), 'document', 'the cache write stands — deferral belongs to the orchestration')
  })

  it('a cache quota failure still attempts the primary and reports through onCacheWrite (data-06)', async () => {
      const log: string[] = []
      const quotaCache: StringStore = {
          ...fakeStringStore('cache', log),
          async write() { log.push('cache:write'); throw new StoreError('too-large', 'quota') }
      }
      const primary = fakeStringStore('primary', log)
      const outcomes: Array<unknown | null> = []
      const store = cached(primary, quotaCache, { onCacheWrite: error => outcomes.push(error) })

      const token = await store.write('document')
      assertEqual(token, 'primary-token', 'resolves with the primary token — the remote save stands')
      assert(log.includes('primary:write'), 'the primary was still attempted — durable remotely, minus the silence')
      assertEqual(await primary.read(), 'document', 'primary holds the save')
      assertEqual(outcomes.length, 1, 'the cache outcome is reported once')
      assert(outcomes[0] instanceof StoreError && outcomes[0].code === 'too-large', 'the cache error reaches the orchestration')
  })

  it('a successful cache write reports null so the save-failed state can clear', async () => {
      const outcomes: Array<unknown | null> = []
      const store = cached(
          fakeStringStore('primary', []),
          fakeStringStore('cache', []),
          { onCacheWrite: error => outcomes.push(error) }
      )

      await store.write('document')
      assertEqual(outcomes.length, 1, 'one cache outcome')
      assertEqual(outcomes[0], null, 'success clears the local save-failed state')
  })

  it('without a hook the cache quota failure still propagates (contract default)', async () => {
      const quotaCache: StringStore = {
          ...fakeStringStore('cache', []),
          async write() { throw new StoreError('too-large', 'quota') }
      }
      const store = cached(fakeStringStore('primary', []), quotaCache)

      await expectStoreError(() => store.write('document'), 'too-large', 'no hook: the error is not swallowed')
  })

  // ─── read ────────────────────────────────────────────────────────────────────
})

describe('cached() — read', () => {

  it('reads come from the primary', async () => {
      const store = cached(
          fakeStringStore('primary', [], { initial: 'from primary' }),
          fakeStringStore('cache', [], { initial: 'from cache' })
      )
      assertEqual(await store.read(), 'from primary', 'primary is the source of truth')
  })

  it('a network failure falls back to the cache', async () => {
      const offline: StringStore = {
          ...fakeStringStore('primary', []),
          async read() { throw new StoreError('network', 'unreachable') }
      }
      const store = cached(offline, fakeStringStore('cache', [], { initial: 'cached copy' }))
      assertEqual(await store.read(), 'cached copy', 'mid-session connectivity loss reads the cache')
  })

  it('only network falls back — remote-rekeyed propagates untouched', async () => {
      const rekeyed: StringStore = {
          ...fakeStringStore('primary', []),
          async read() { throw new StoreError('remote-rekeyed', 'rotated elsewhere') }
      }
      const store = cached(rekeyed, fakeStringStore('cache', [], { initial: 'stale cached copy' }))
      await expectStoreError(() => store.read(), 'remote-rekeyed', 'no cache fallback for typed errors')
  })

  // ─── exists / head / unlock / clear ──────────────────────────────────────────
})

describe('cached() — exists, head, unlock, clear', () => {

  it('exists is the union — offline boot still shows the lock screen', async () => {
      const neither = cached(fakeStringStore('primary', []), fakeStringStore('cache', []))
      assertEqual(await neither.exists(), false, 'neither side')

      const cacheOnly = cached(
          fakeStringStore('primary', []),
          fakeStringStore('cache', [], { initial: 'data' })
      )
      assertEqual(await cacheOnly.exists(), true, 'cache alone suffices')

      const primaryOnly = cached(
          fakeStringStore('primary', [], { initial: 'data' }),
          fakeStringStore('cache', [])
      )
      assertEqual(await primaryOnly.exists(), true, 'primary alone suffices')
  })

  it('head is primary-only', async () => {
      const log: string[] = []
      const store = cached(
          fakeStringStore('primary', log, { initial: 'data' }),
          fakeStringStore('cache', log, { initial: 'data' })
      )
      assertEqual(await store.head!(), 'primary-token', 'primary token')
      assertEqual(log.filter(entry => entry === 'cache:head').length, 0, 'the cache is never probed for head')
  })

  it('unlock is primary-only and returns its UnlockResult (offline unlock is a future capability, OQ 8)', async () => {
      const log: string[] = []
      const store = cached(
          fakeStringStore('primary', log, { initial: 'remote text' }),
          fakeStringStore('cache', log, { initial: 'cached text' })
      )
      const result = await store.unlock?.('passphrase')
      assert(log.includes('primary:unlock'), 'primary unlocked')
      assertEqual(log.includes('cache:unlock'), false, 'cache not unlocked')
      assertEqual(result?.text, 'remote text', 'the primary result is passed through')
      assertEqual(result?.headToken, 'primary-token', 'the primary head token comes with it')
  })

  it('clear clears both sides', async () => {
      const log: string[] = []
      const primary = fakeStringStore('primary', log, { initial: 'data' })
      const cache = fakeStringStore('cache', log, { initial: 'data' })
      const store = cached(primary, cache)
      await store.clear()
      assertEqual(await primary.exists(), false, 'primary cleared')
      assertEqual(await cache.exists(), false, 'cache cleared')
  })

  it('capabilities come from the primary', () => {
      const store = cached(fakeStringStore('primary', []), fakeStringStore('cache', []))
      assertEqual(store.capabilities.durable, 'always', 'primary durability')
  })

  // ─── full composition ────────────────────────────────────────────────────────
})

describe('cached() — full Remote composition shape', () => {

  it('cached(encrypted(supabase-like raw), encrypted(slot-like raw)) shares one session and round-trips', async () => {
      // Two raw stores sharing one KeySession, exactly like the Remote
      // composition: the backend row and the local cache slot.
      const session = createKeySession()
      const remoteRaw = fakeRaw()
      const cacheRaw = fakeRaw()
      const remoteStore = cached(encrypted(remoteRaw, session), encrypted(cacheRaw, session))

      await remoteStore.unlock!('shared-pass-123')   // verifies against the primary (empty → adoption)
      const token = await remoteStore.write('remote document')

      assertEqual(await remoteStore.read(), 'remote document', 'read round-trip')
      assertEqual(remoteRaw.writes.length, 1, 'backend row written')
      assertEqual(cacheRaw.writes.length, 1, 'local cache written')
      assertEqual(remoteRaw.writes[0].salt, cacheRaw.writes[0].salt, 'both copies carry the same salt')
      assertEqual(await remoteStore.head!(), token, 'head tracks the primary')
      assertEqual(remoteStore.capabilities.encrypted, true, 'encrypted through the composition')
  })
})