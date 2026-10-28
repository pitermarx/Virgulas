import { describe, it } from 'bun:test'
// encrypted() decorator suite (docs/storage-interface.md §10, rollout PR 2a):
// envelope round-trip, salt reuse, legacy 310k decrypt + upgrade-on-save,
// WrongKey mapping, key-cache behaviour (sync-10), remote-rekeyed (sync-01),
// rotation flow (§6.7).

import { encrypted, createKeySession, type KeySession } from '../../../source/js/encryptedStore.js'
import { StoreError, type RawRecord, type RawStore } from '../../../source/js/storage.js'
import {
    DEFAULT_ITERATIONS,
    LEGACY_ITERATIONS,
    WrongPassphraseError,
    CorruptEnvelopeError,
    UnsupportedVersionError,
    encrypt,
    generateSalt,
    getEnvelopeIterations
} from '../../../source/js/crypto2.js'
import { assert, assertEqual } from '../testing.js'

const PASS = 'correct-pass-123'
const PASS2 = 'rotated-pass-456'

function fakeRaw(): RawStore & { records: RawRecord[]; writes: RawRecord[] } {
    const records: RawRecord[] = []
    const writes: RawRecord[] = []
    return {
        records,
        writes,
        capabilities: { durable: 'always', encrypted: false, authenticated: false, changeDetection: true, available: true },
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

async function expectStoreError(fn: () => Promise<unknown>, code: string, label: string): Promise<StoreError> {
    let threw: any = null
    try { await fn() } catch (e) { threw = e }
    assert(threw instanceof StoreError, `${label}: threw StoreError (got ${threw?.constructor?.name})`)
    assertEqual(threw.code, code, `${label}: code`)
    return threw
}

/** Patches WebCrypto to count PBKDF2 derivations for the call's duration.
 * crypto2 reads `window.crypto.subtle` (happy-dom's window in unit tests),
 * so that is the object that must be patched. */
async function withDerivationCount(fn: (count: () => number) => Promise<void>): Promise<void> {
    const window_ = (globalThis as any).window
    const subtle = (window_?.crypto?.subtle ?? (globalThis as any).crypto.subtle)
    const original = subtle.deriveKey.bind(subtle)
    let count = 0
    subtle.deriveKey = async (...args: any[]) => {
        count += 1
        return original(...args)
    }
    try {
        await fn(() => count)
    } finally {
        subtle.deriveKey = original
    }
}

// ─── lifecycle ───────────────────────────────────────────────────────────────


describe('encrypted() — lifecycle', () => {

  it('first-time setup adopts the passphrase with a fresh salt; write/read round-trips', async () => {
      const raw = fakeRaw()
      const store = encrypted(raw, createKeySession())

      await store.unlock(PASS)   // empty store → adoption, nothing to verify
      assertEqual(await raw.readRaw(), null, 'adoption persists nothing until the first write')

      const token = await store.write('document one')
      const record = await raw.readRaw()
      assert(!!record?.salt, 'the first write persists the adopted salt')
      assertEqual(await store.read(), 'document one', 'round-trip')
      assertEqual(typeof token, 'string', 'write resolves with the raw token')
  })

  it('unlock verifies against the at-rest payload; wrong key maps to wrong-key with the original cause', async () => {
      const raw = fakeRaw()
      const salt = generateSalt()
      raw.records.push({ data: await encrypt('secret text', PASS, salt), salt })

      const store = encrypted(raw, createKeySession())
      const error = await expectStoreError(() => store.unlock('not-the-passphrase'), 'wrong-key', 'wrong key')
      assert(error.cause instanceof WrongPassphraseError, 'cause is the crypto2 typed error (two-channel)')

      await store.unlock(PASS)
      assertEqual(await store.read(), 'secret text', 'correct passphrase unlocks')
  })

  it('read/write while locked throw unauthenticated', async () => {
      const store = encrypted(fakeRaw(), createKeySession())
      await expectStoreError(() => store.read(), 'unauthenticated', 'locked read')
      await expectStoreError(() => store.write('x'), 'unauthenticated', 'locked write')
  })

  it('lock() drops the session; exists() and head() never need it', async () => {
      const raw = fakeRaw()
      const salt = generateSalt()
      raw.records.push({ data: await encrypt('secret text', PASS, salt), salt })

      const store = encrypted(raw, createKeySession())
      assertEqual(await store.exists(), true, 'exists with no passphrase')
      assertEqual(await store.head!(), 'token-0', 'head with no passphrase')

      await store.unlock(PASS)
      await store.lock()
      await expectStoreError(() => store.read(), 'unauthenticated', 'locked after lock()')
  })

  // ─── envelope compatibility ──────────────────────────────────────────────────
})

describe('encrypted() — envelope compatibility', () => {

  it('a legacy 310k envelope decrypts, and the next save upgrades it to current parameters', async () => {
      const raw = fakeRaw()
      const salt = generateSalt()
      const legacy = (await encrypt('legacy payload', PASS, salt, LEGACY_ITERATIONS))
          .replace(/^v\d+:\d+:/, '')   // raw base64, pre-v2 at-rest shape
      raw.records.push({ data: legacy, salt })

      const store = encrypted(raw, createKeySession())
      await store.unlock(PASS)
      assertEqual(await store.read(), 'legacy payload', 'legacy envelope decrypts')

      await store.write('legacy payload updated')
      const upgraded = (await raw.readRaw())!.data
      assert(upgraded.startsWith(`v2:${DEFAULT_ITERATIONS}:`), 'save re-encrypts at current parameters')
      assertEqual(getEnvelopeIterations(upgraded), DEFAULT_ITERATIONS, 'recorded iterations upgraded')
  })

  it('a versioned envelope written at legacy iterations also upgrades on save', async () => {
      const raw = fakeRaw()
      const salt = generateSalt()
      raw.records.push({ data: await encrypt('v2 legacy', PASS, salt, LEGACY_ITERATIONS), salt })

      const store = encrypted(raw, createKeySession())
      await store.unlock(PASS)
      await store.write('v2 legacy updated')
      assertEqual(getEnvelopeIterations((await raw.readRaw())!.data), DEFAULT_ITERATIONS, 'upgraded')
  })

  it('a corrupt envelope maps to corrupt-data (no passphrase is wrong), cause preserved', async () => {
      const raw = fakeRaw()
      raw.records.push({ data: 'not-valid-base64!!', salt: generateSalt() })

      const store = encrypted(raw, createKeySession())
      const error = await expectStoreError(() => store.unlock(PASS), 'corrupt-data', 'corrupt envelope')
      assert(error.cause instanceof CorruptEnvelopeError, 'cause is CorruptEnvelopeError')
  })

  it('a record without a salt maps to corrupt-data', async () => {
      const raw = fakeRaw()
      raw.records.push({ data: 'v2:600000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })

      const store = encrypted(raw, createKeySession())
      const error = await expectStoreError(() => store.unlock(PASS), 'corrupt-data', 'missing salt')
      assert(error.cause instanceof CorruptEnvelopeError, 'cause is CorruptEnvelopeError')
  })

  it('a future envelope version maps to unsupported-runtime', async () => {
      const raw = fakeRaw()
      raw.records.push({ data: 'v3:600000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', salt: generateSalt() })

      const store = encrypted(raw, createKeySession())
      const error = await expectStoreError(() => store.unlock(PASS), 'unsupported-runtime', 'future envelope')
      assert(error.cause instanceof UnsupportedVersionError, 'cause is UnsupportedVersionError')
  })

  // ─── salt policy ────────────────────────────────────────────────────────────
})

describe('encrypted() — salt policy', () => {

  it('the salt is generated once and reused across writes', async () => {
      const raw = fakeRaw()
      const store = encrypted(raw, createKeySession())
      await store.unlock(PASS)
      await store.write('one')
      await store.write('two')
      await store.write('three')
      const salts = raw.writes.map(w => w.salt)
      assertEqual(new Set(salts).size, 1, 'one salt across all writes')
  })

  it('a pulled record under a foreign salt raises remote-rekeyed, with no write afterwards (sync-01)', async () => {
      const raw = fakeRaw()
      const saltA = generateSalt()
      raw.records.push({ data: await encrypt('device A document', PASS, saltA), salt: saltA })

      const store = encrypted(raw, createKeySession())
      await store.unlock(PASS)

      // Another device rotates the passphrase: fresh salt, fresh passphrase.
      const saltB = generateSalt()
      raw.records[0] = { data: await encrypt('rotated document', PASS2, saltB), salt: saltB }

      const writesBefore = raw.writes.length
      await expectStoreError(() => store.read(), 'remote-rekeyed', 'foreign salt')
      assertEqual(raw.writes.length, writesBefore, 'the failed read performs no write (no clobbering push)')

      // A locked device meets the rotated record as a plain wrong key.
      const locked = encrypted(raw, createKeySession())
      await expectStoreError(() => locked.unlock(PASS), 'wrong-key', 'stale passphrase on rotated record')
      await locked.unlock(PASS2)
      assertEqual(await locked.read(), 'rotated document', 'new passphrase reads the rotated record')
  })

  // ─── rotation (§6.7) ─────────────────────────────────────────────────────────
})

describe('encrypted() — rotation', () => {

  it('rotate() re-keys under a fresh salt; the old passphrase can no longer unlock', async () => {
      const raw = fakeRaw()
      const session: KeySession = createKeySession()
      const store = encrypted(raw, session)

      await store.unlock(PASS)
      await store.write('original document')
      const saltBefore = (await raw.readRaw())!.salt

      session.rotate(PASS2)
      await store.write('re-encrypted document')

      const record = (await raw.readRaw())!
      assert(record.salt !== saltBefore, 'rotation generates a fresh salt')
      assertEqual(await store.read(), 're-encrypted document', 'reads under the new key')

      const stale = encrypted(raw, createKeySession())
      await expectStoreError(() => stale.unlock(PASS), 'wrong-key', 'old passphrase rejected')
      await stale.unlock(PASS2)
      assertEqual(await stale.read(), 're-encrypted document', 'new passphrase unlocks the rotated record')
  })

  // ─── key cache (sync-10) ─────────────────────────────────────────────────────
})

describe('encrypted() — key cache', () => {

  it('one derivation per (passphrase, salt); lock() drops the key so unlocking derives again', async () => {
      // Self-contained: a passphrase never derived elsewhere in the suite and a
      // freshly adopted salt, so the derivation happens inside the counter scope.
      await withDerivationCount(async count => {
          const raw = fakeRaw()
          const store = encrypted(raw, createKeySession())
          await store.unlock('kdf-count-pass-1')   // adoption on empty store — no derivation
          await store.write('cache me')             // derivation 1
          await store.read()
          await store.write('cache me again')      // cached key
          await store.read()
          assertEqual(count(), 1, 'one derivation while the session stays unlocked')

          await store.lock()
          await store.unlock('kdf-count-pass-1')   // same pair, but the cache was dropped
          await store.read()                        // derivation 2
          assertEqual(count(), 2, 'lock() clears the derived-key cache (docs §4.3 item 6)')
      })
  })

  it('rotate() drops the old key: the previous derivation is not reused', async () => {
      await withDerivationCount(async count => {
          const raw = fakeRaw()
          const session = createKeySession()
          const store = encrypted(raw, session)
          await store.unlock('kdf-rotate-old')      // adoption — fresh salt, no derivation
          await store.write('before rotation')      // derivation 1 (old passphrase)
          const beforeRecord = { ...raw.records[0] }
          assertEqual(count(), 1, 'the old passphrase key is derived once')

          // A second session on the same (passphrase, salt) pair reuses it.
          const oldRaw = fakeRaw()
          await oldRaw.writeRaw(beforeRecord)
          const oldStore = encrypted(oldRaw, createKeySession())
          await oldStore.unlock('kdf-rotate-old')
          assertEqual(count(), 1, 'the pre-rotation key is still cached for its pair')

          session.rotate('kdf-rotate-new')
          await store.write('after rotation')       // derivation 2 (new passphrase)
          assertEqual(count(), 2, 'the new pair derives once after rotation')

          // The pre-rotation pair has no cached key any more: it must derive
          // again, which proves rotation evicted it rather than leaving the old
          // passphrase reachable in the cache key (docs §4.3 item 6).
          await oldStore.unlock('kdf-rotate-old')
          assertEqual(count(), 3, 'rotation dropped the old passphrase key')
          assertEqual(await oldStore.read(), 'before rotation', 'the old record still decrypts')
      })
  })

  it('alternating salts derive once each, not once per operation (sync-10)', async () => {
      await withDerivationCount(async count => {
          const storeA = encrypted(fakeRaw(), createKeySession())
          const storeB = encrypted(fakeRaw(), createKeySession())
          await storeA.unlock('kdf-count-pass-a')   // adoption — fresh salt A
          await storeB.unlock('kdf-count-pass-b')   // adoption — fresh salt B
          await storeA.write('document A')          // derivation 1
          await storeB.write('document B')          // derivation 2
          await storeA.read()
          await storeB.read()
          await storeA.write('document A again')   // must hit the multi-entry cache
          await storeB.write('document B again')
          await storeA.read()
          await storeB.read()
          assertEqual(count(), 2, 'alternating salts cost one derivation each')
      })
  })
})