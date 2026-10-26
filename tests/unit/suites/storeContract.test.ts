import { describe, it } from 'bun:test'
// Contract conformance suite (docs/storage-interface.md §10, rollout PR 2a).
// Every adapter runs against the same behavioural spec: upsert semantics,
// exists-without-key, head invariants, typed errors, capability descriptors.
// This is the piece that makes future backends cheap to trust — a new adapter
// proves itself against this file instead of against the whole app.
//
// PR 2a adapters: memory, file (fake handle), local slot (fake + real slot),
// encrypted-over-fake-raw, codecStore lift. cached() pairs join in PR 2b.

import { memoryStore } from '../../../source/js/memoryStore.js'
import { fileStore, isFileStoreAvailable } from '../../../source/js/fileStore.js'
import { slotRaw } from '../../../source/js/localStore.js'
import { encrypted, createKeySession } from '../../../source/js/encryptedStore.js'
import { codecStore, jsonCodec } from '../../../source/js/docCodec.js'
import { StoreError, type RawRecord, type RawStore, type StringStore } from '../../../source/js/storage.js'
import { store } from '../../../source/js/utils.js'
import { assert, assertEqual } from '../testing.js'

// ─── fakes ───────────────────────────────────────────────────────────────────

/** In-memory RawStore with a write log, for encrypted() and adapter tests. */
function fakeRaw(capabilities?: Partial<RawStore['capabilities']>): RawStore & { records: RawRecord[]; writes: RawRecord[] } {
    const records: RawRecord[] = []
    const writes: RawRecord[] = []
    return {
        records,
        writes,
        capabilities: {
            durable: 'always',
            encrypted: false,
            authenticated: false,
            changeDetection: true,
            available: true,
            ...capabilities
        },
        async readRaw() { return records[0] ?? null },
        async writeRaw(record) {
            writes.push(record)
            records[0] = record
            return `token-${writes.length}`
        },
        async clearRaw() { records.length = 0 },
        async exists() { return records.length > 0 },
        async head() { return records.length > 0 ? `token-${writes.length}` : null }
    }
}

function fakeFileHandle() {
    let text = ''
    let lastModified = 1000
    return {
        async getFile() {
            return {
                get size() { return text.length },
                get lastModified() { return lastModified },
                async text() { return text }
            }
        },
        async createWritable() {
            return {
                async write(next: string) { text = next; lastModified += 1000 },
                async close() { }
            }
        },
        get currentText() { return text }
    }
}

type Slot = typeof store.data
function fakeSlot(options: { quota?: number } = {}) {
    let value: string | null = null
    const quota = options.quota ?? Number.POSITIVE_INFINITY
    const slot: Slot = {
        get(fallback: string | null = null) { return value === null ? fallback : value },
        set(next: string | null | undefined): boolean {
            if (next === null || next === undefined) { value = null; return true }
            if (next.length > quota) return false
            value = next
            return true
        },
        del(): boolean { value = null; return true }
    }
    return slot
}

async function expectStoreError(fn: () => Promise<unknown>, code: string, label: string) {
    let threw: any = null
    try { await fn() } catch (e) { threw = e }
    assert(threw instanceof StoreError, `${label}: threw StoreError (got ${threw?.constructor?.name})`)
    assertEqual(threw.code, code, `${label}: code`)
    return threw
}

// ─── raw-store contract ──────────────────────────────────────────────────────

async function rawStoreContract(make: () => RawStore, label: string) {
    describe(`contract — raw store (${label})`, () => {

    it('readRaw is null before any write; exists is false', async () => {
        const raw = make()
        assertEqual(await raw.readRaw(), null, 'no record initially')
        assertEqual(await raw.exists(), false, 'exists false initially')
    })

    it('writeRaw/readRaw round-trip with upsert semantics (no read-before-write)', async () => {
        const raw = make()
        await raw.writeRaw({ data: 'first', salt: 'salt-a' })
        assertEqual((await raw.readRaw())?.data, 'first', 'first write lands')
        await raw.writeRaw({ data: 'second', salt: 'salt-b' })
        assertEqual((await raw.readRaw())?.data, 'second', 'second write upserts')
        assertEqual((await raw.readRaw())?.salt, 'salt-b', 'salt carried')
    })

    it('writeRaw resolves with the token head() reports; head stable when unchanged', async () => {
        const raw = make()
        const token = await raw.writeRaw({ data: 'first', salt: 'salt-a' })
        assertEqual(await raw.head!(), token, 'write token equals head')
        const again = await raw.head!()
        assertEqual(again, token, 'head stable when nothing changed')
    })

    it('clearRaw removes the record', async () => {
        const raw = make()
        await raw.writeRaw({ data: 'first', salt: 'salt-a' })
        await raw.clearRaw()
        assertEqual(await raw.readRaw(), null, 'record gone')
        assertEqual(await raw.exists(), false, 'exists false after clear')
    })
    })
}

// ─── string-store contract ───────────────────────────────────────────────────

async function stringStoreContract(make: () => StringStore, label: string, opts: { passphrase?: string } = {}) {
    const encryptedStore = opts.passphrase !== undefined
    describe(`contract — string store (${label})`, () => {

    it('read() is null on an empty store, never throws for it', async () => {
        const s = make()
        if (encryptedStore) {
            await s.unlock!(opts.passphrase!)  // first-time setup on empty
        }
        assertEqual(await s.read(), null, 'empty store reads null')
    })

    it('exists() needs no passphrase or unlock', async () => {
        const s = make()
        assertEqual(await s.exists(), false, 'empty store: exists false while locked')
        if (encryptedStore) {
            await s.unlock!(opts.passphrase!)
            await s.write('payload')
            await s.lock!()
            assertEqual(await s.exists(), true, 'seeded store: exists true while locked')
        }
    })

    it('write()→read() round-trip; write resolves with the head token', async () => {
        const s = make()
        if (encryptedStore) await s.unlock!(opts.passphrase!)
        const token = await s.write('hello world')
        assertEqual(await s.read(), 'hello world', 'round-trip')
        if (s.head) assertEqual(await s.head(), token, 'write token equals head')
        const stable = await s.head?.()
        assertEqual(await s.head?.(), stable, 'head stable when unchanged')
    })

    it('upsert semantics: second write replaces the first', async () => {
        const s = make()
        if (encryptedStore) await s.unlock!(opts.passphrase!)
        await s.write('one')
        await s.write('two')
        assertEqual(await s.read(), 'two', 'last write wins')
    })

    it('clear() empties the store', async () => {
        const s = make()
        if (encryptedStore) await s.unlock!(opts.passphrase!)
        await s.write('data')
        await s.clear()
        assertEqual(await s.read(), null, 'read null after clear')
        assertEqual(await s.exists(), false, 'exists false after clear')
    })

    if (encryptedStore) {
        it('read()/write() while locked throw a typed error', async () => {
            const s = make()
            await expectStoreError(() => s.read(), 'unauthenticated', 'locked read')
            await expectStoreError(() => s.write('x'), 'unauthenticated', 'locked write')
        })

        it('unlock with the wrong passphrase throws wrong-key', async () => {
            const s = make()
            await s.unlock!(opts.passphrase!)
            await s.write('secret')
            await s.lock!()
            const error = await expectStoreError(() => s.unlock!('wrong-passphrase'), 'wrong-key', 'wrong passphrase')
            assert(error.cause, 'cause preserved (two-channel errors)')
        })

        it('capabilities advertise encrypted: true', async () => {
            const s = make()
            assertEqual(s.capabilities.encrypted, true, 'encrypted capability')
        })
    } else {
        it('capabilities advertise encrypted: false', async () => {
            const s = make()
            assertEqual(s.capabilities.encrypted, false, 'plain store')
        })
    }
    })
}

// ─── doc-store lift ──────────────────────────────────────────────────────────

async function docStoreContract(make: () => StringStore, label: string) {
    describe(`contract — codecStore lift (${label})`, () => {

    it('codecStore round-trips documents through the codec', async () => {
        const docStore = codecStore(jsonCodec, make())
        const doc = { modelVersion: 'v1', dataVersion: 1, nodes: [{ id: 'root', children: [] }] }
        const token = await docStore.write(doc)
        const read = await docStore.read()
        assertEqual(read?.nodes.length, 1, 'document read back')
        assertEqual(read?.nodes[0].id, 'root', 'root preserved')
        if (docStore.head) assertEqual(await docStore.head(), token, 'token passthrough')
    })

    it('codecStore parse failure is a typed invalid-document error', async () => {
        const inner = make()
        await inner.write('not json at all')
        const docStore = codecStore(jsonCodec, inner)
        await expectStoreError(() => docStore.read(), 'invalid-document', 'bad document')
    })
    })
}

// ─── run the contracts ──────────────────────────────────────────────────────

await rawStoreContract(() => fakeRaw(), 'fake raw')
await rawStoreContract(() => slotRaw(fakeSlot()), 'local slot (fake)')

await stringStoreContract(() => memoryStore(), 'memory')
await stringStoreContract(() => fileStore(fakeFileHandle() as unknown as FileSystemFileHandle), 'file (fake handle)')

const sharedRaw = fakeRaw()
await stringStoreContract(() => encrypted(sharedRaw, createKeySession()), 'encrypted over fake raw', { passphrase: 'test-passphrase-123' })

const sharedSlot = fakeSlot()
await stringStoreContract(() => encrypted(slotRaw(sharedSlot), createKeySession()), 'encrypted over local slot', { passphrase: 'test-passphrase-123' })

await docStoreContract(() => memoryStore(), 'memory')

// ─── unlock result passthrough ──────────────────────────────────────────────

describe('contract — codecStore unlock passthrough', () => {

  it('returns the encrypted store\'s UnlockResult so callers need no inner handle', async () => {
      const raw = fakeRaw()
      const docStore = codecStore(jsonCodec, encrypted(raw, createKeySession()))

      const fresh = await docStore.unlock!('test-passphrase-123')
      assertEqual(fresh?.text, null, 'first-time setup reports no document')

      await docStore.write({ modelVersion: 'v1', dataVersion: 1, nodes: [{ id: 'root', children: [] }] })
      await docStore.lock!()
      const reopened = await docStore.unlock!('test-passphrase-123')
      assertEqual(typeof reopened?.text, 'string', 'the downloaded document text comes back')
      assertEqual(reopened?.text?.includes('"root"'), true, 'it is the stored document')
  })
})

// ─── capability descriptors (§10) ────────────────────────────────────────────


describe('capability descriptors', () => {

  it('memory: durable never, change detection on, always available', () => {
      const caps = memoryStore().capabilities
      assertEqual(caps.durable, 'never', 'memory durability')
      assertEqual(caps.changeDetection, true, 'head available')
      assertEqual(caps.available, true, 'no environment requirement')
      assertEqual(caps.encrypted, false, 'not encrypted')
  })

  it('file: durable always, available tracks showSaveFilePicker presence', () => {
      assertEqual(isFileStoreAvailable({} as any), false, 'unavailable without the API')
      assertEqual(isFileStoreAvailable({ showSaveFilePicker: () => { } } as any), true, 'available with the API')
      const caps = fileStore(fakeFileHandle() as unknown as FileSystemFileHandle).capabilities
      assertEqual(caps.durable, 'always', 'file durability')
      assertEqual(caps.available, isFileStoreAvailable(), 'available mirrors the probe')
  })

  it('local slot: durable prompt (evictable, persist() prompt hangs off this)', () => {
      const caps = slotRaw(fakeSlot()).capabilities
      assertEqual(caps.durable, 'prompt', 'local durability')
      assertEqual(caps.encrypted, false, 'raw level is not encrypted')
  })

  it('encrypted() inherits the inner descriptor and sets encrypted: true', () => {
      const raw = fakeRaw({ durable: 'prompt' })
      const caps = encrypted(raw, createKeySession()).capabilities
      assertEqual(caps.durable, 'prompt', 'inherited durability')
      assertEqual(caps.encrypted, true, 'encryption is the decorator\u2019s doing')
      assertEqual(caps.changeDetection, true, 'inherited change detection')
  })

  // ─── local slot specifics ────────────────────────────────────────────────────
})

describe('local slot adapter', () => {

  it('the real store.data slot round-trips through slotRaw (snapshot restored)', async () => {
      const before = store.data.get()
      try {
          const raw = slotRaw(store.data)
          assertEqual(await raw.readRaw(), null, 'clean slate')
          const token = await raw.writeRaw({ data: 'envelope-data', salt: 'salt-value' })
          const record = await raw.readRaw()
          assertEqual(record?.data, 'envelope-data', 'data round-trips')
          assertEqual(record?.salt, 'salt-value', 'salt round-trips')
          assertEqual(await raw.head!(), token, 'content-hash head')
          assertEqual(await raw.exists(), true, 'exists')
          await raw.clearRaw()
          assertEqual(await raw.readRaw(), null, 'cleared')
      } finally {
          if (before === null) store.data.del()
          else store.data.set(before)
      }
  })

  it('a slot value without the salt separator reads as no record (today\u2019s behaviour)', async () => {
      const slot = fakeSlot()
      slot.set('no-separator-here')
      const raw = slotRaw(slot)
      assertEqual(await raw.readRaw(), null, 'malformed value reads as empty')
      assertEqual(await raw.exists(), true, 'but the slot is occupied — exists is a storage probe')
  })

  it('a quota failure on write surfaces as too-large (data-06, adapter half)', async () => {
      const raw = slotRaw(fakeSlot({ quota: 10 }))
      await expectStoreError(() => raw.writeRaw({ data: 'much longer than ten chars', salt: 'salt' }), 'too-large', 'quota exceeded')
  })
})