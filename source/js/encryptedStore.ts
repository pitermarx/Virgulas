// The crypto decorator of the storage seam (docs/storage-interface.md §4.3,
// rollout PR 2a).
//
// encrypted(raw, session) wraps a RawStore into a StringStore: everything
// above sees plaintext strings, everything below sees opaque records. This is
// the only module besides crypto2.ts and biometrics.ts that touches key
// material (AGENTS Rule 7) — all actual crypto goes through crypto2.ts.
//
// KeySession is the single in-memory retention point for the session
// passphrase: orchestration holds no secrets (Goal 2). Derivation caching
// lives inside crypto2's multi-entry key cache, so autosave never re-runs the
// 600k PBKDF2 and alternating salts (local cache vs rotated remote) cost one
// derivation each, not one per operation (sync-10).

import {
    CorruptEnvelopeError,
    UnsupportedBrowserError,
    UnsupportedVersionError,
    WrongPassphraseError,
    decrypt,
    encrypt,
    generateSalt
} from './crypto2.js'
import { StoreError, type RawStore, type StringStore, type UnlockResult } from './storage.js'

// ── KeySession ──────────────────────────────────────────────────────────────

export interface KeySession {
    /** The salt writes encrypt under this session. Set by a successful
     * unlock-decrypt, first-time setup, or rotation; null while locked. */
    readonly activeSalt: string | null

    /** True when a passphrase is retained (unlocked, or first-time setup done). */
    readonly unlocked: boolean

    /** Make (passphrase, salt) the active pair — a successful unlock or setup. */
    activate(passphrase: string, salt: string): void

    /**
     * Rotation / first-time setup with a fresh salt: a fresh salt is generated
     * and the new passphrase becomes active. Subsequent writes re-encrypt
     * everything under the new key (docs §6.7); derivation itself is lazy —
     * crypto2 derives on the next encrypt/decrypt and caches the result.
     */
    rotate(newPassphrase: string): void

    /** Drop the passphrase and the active salt (lock, sign-out, teardown). */
    lock(): void

    /** Credentials for crypto2 calls; null while locked. */
    activeCredentials(): { passphrase: string; salt: string } | null
}

export function createKeySession(): KeySession {
    let passphrase: string | null = null
    let salt: string | null = null

    return {
        get activeSalt() { return salt },
        get unlocked() { return passphrase !== null && salt !== null },
        activate(nextPassphrase: string, nextSalt: string) {
            passphrase = nextPassphrase
            salt = nextSalt
        },
        rotate(newPassphrase: string) {
            passphrase = newPassphrase
            salt = generateSalt()
        },
        lock() {
            passphrase = null
            salt = null
        },
        activeCredentials() {
            return passphrase !== null && salt !== null ? { passphrase, salt } : null
        }
    }
}

// ── Error mapping (§4.4) ─────────────────────────────────────────────────────

/**
 * Crypto-layer mapping: always attaches the original crypto2 typed error as
 * `cause`, so the lock screen's existing instanceof branches keep working.
 * GCM failure during unlock remains 'wrong-key'; a broken envelope is
 * 'corrupt-data' (no passphrase is wrong); future envelopes and missing
 * browser APIs are 'unsupported-runtime'.
 */
function mapCryptoError(error: unknown): never {
    if (error instanceof WrongPassphraseError) {
        throw new StoreError('wrong-key', 'Invalid passphrase.', error)
    }
    if (error instanceof CorruptEnvelopeError) {
        throw new StoreError('corrupt-data', error.message, error)
    }
    if (error instanceof UnsupportedVersionError || error instanceof UnsupportedBrowserError) {
        throw new StoreError('unsupported-runtime', error.message, error)
    }
    throw error
}

function requireCredentials(session: KeySession): { passphrase: string; salt: string } {
    const credentials = session.activeCredentials()
    if (!credentials) {
        throw new StoreError('unauthenticated', 'The store is locked. Unlock (or set up) the session first.')
    }
    return credentials
}

// ── The decorator (§4.3) ─────────────────────────────────────────────────────

/**
 * Wraps a RawStore into an encrypted StringStore. Capabilities are inherited
 * from the inner raw store with `encrypted: true`. Salt handling is the
 * decorator's job: it is carried in `RawRecord.salt`, and the inner adapter
 * decides where it physically lives (slot prefix, DB column, or inline).
 *
 * Lifecycle (docs §6.2):
 * - `unlock(passphrase)` performs the one-and-only passphrase verification per
 *   session: derive, attempt decryption of the at-rest payload, throw
 *   StoreError('wrong-key') on AES-GCM authentication failure. There is
 *   deliberately no separate "verify passphrase" primitive — decryption is the
 *   verifier.
 * - On an empty store, unlock *adopts* the passphrase with a fresh salt
 *   (first-time setup wraps the first write — the decorator generates the
 *   salt once and reuses it).
 * - A successful save of a legacy 310k envelope re-encrypts at current
 *   parameters (upgrade-on-save, unchanged).
 * - A read whose record salt differs from the session's active salt raises
 *   'remote-rekeyed' (another device rotated the passphrase) — never swallowed
 *   and never followed by a push (fixes sync-01).
 */
export interface EncryptedStore extends StringStore {
    /** Verifies the passphrase by decrypting the at-rest payload (decryption is
     * the verifier) and returns the decrypted text plus the record's change
     * token. One round-trip: no separate read is needed. */
    unlock(passphrase: string): Promise<UnlockResult>
    lock(): Promise<void>
}
export function encrypted(raw: RawStore, session: KeySession): EncryptedStore {
    return {
        async read() {
            requireCredentials(session)
            const record = await raw.readRaw()
            if (!record?.data) return null
            const credentials = session.activeCredentials()!
            try {
                return await decrypt(record.data, credentials.passphrase, record.salt || credentials.salt)
            } catch (error) {
                // sync-01: a decryption failure on a record whose salt differs
                // from the session's means another device rotated the
                // passphrase — the stale key must never silently win. Same-salt
                // failures stay wrong-key (a legitimately different salt with
                // the same passphrase still decrypts).
                if (error instanceof WrongPassphraseError
                    && record.salt && session.activeSalt
                    && record.salt !== session.activeSalt) {
                    throw new StoreError(
                        'remote-rekeyed',
                        'The stored document was re-encrypted with a different passphrase (rotated on another device). Unlock with the new passphrase to continue.',
                        error
                    )
                }
                mapCryptoError(error)
            }
        },

        async write(text) {
            const credentials = requireCredentials(session)
            const envelope = await encrypt(text, credentials.passphrase, credentials.salt)
            return raw.writeRaw({ data: envelope, salt: credentials.salt })
        },

        async clear() {
            await raw.clearRaw()
        },

        exists() {
            return raw.exists()
        },

        async head() {
            return raw.head?.() ?? null
        },

        async unlock(passphrase) {
            const record = await raw.readRaw()
            if (!record?.data) {
                // First-time setup: nothing to verify. A fresh salt becomes
                // active and the first write persists it (today's behaviour).
                session.activate(passphrase, record?.salt || generateSalt())
                return { text: null, headToken: null }
            }
            if (!record.salt) {
                throw new StoreError(
                    'corrupt-data',
                    'Local encrypted data is missing its salt.',
                    new CorruptEnvelopeError('Local encrypted data is missing its salt.')
                )
            }
            try {
                const text = await decrypt(record.data, passphrase, record.salt)
                session.activate(passphrase, record.salt)
                return { text, headToken: record.updatedAt ?? null }
            } catch (error) {
                mapCryptoError(error)
            }
        },

        async lock() {
            session.lock()
        },

        capabilities: { ...raw.capabilities, encrypted: true }
    }
}
