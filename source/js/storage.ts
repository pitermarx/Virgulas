// Storage seam contracts (docs/storage-interface.md §4, rollout PR 2a).
//
// Three layers, each owning exactly one representation:
//
//   DocStore      — public, speaks the OutlineDoc model (never serialized text)
//   StringStore   — string payloads; the crypto decorator's upper edge
//   RawStore      — backend adapter below the crypto line; opaque records
//
// Nothing below the codec knows a document format; nothing above the crypto
// line ever sees ciphertext, salts, or envelope formats. AuthProvider is a
// separate contract implemented only by authenticated backends and never
// touches documents.
//
// This module defines contracts only — it must stay free of imports from the
// adapters (no circular dependencies: adapters import storage.ts, never the
// reverse). The `store` slots in utils.ts (Rule 7's vocabulary) are unrelated
// to these capitalized *Store contracts.

import type { OutlineDoc } from './docCodec.js'

// ── Error taxonomy (§4.4) ─────────────────────────────────────────────────────

export type StoreErrorCode =
    | 'wrong-key'           // GCM auth failure during unlock — passphrase is wrong
    | 'remote-rekeyed'      // remote salt ≠ session salt — passphrase rotated elsewhere
    | 'unauthenticated'     // no signed-in user, or the store is locked
    | 'network'             // transport failure — retryable (backoff keys off this)
    | 'not-found'           // backend reports the record does not exist
    | 'too-large'           // payload exceeds the backend's size bound (quota, row limit)
    | 'invalid-document'    // codec parse/validate failure
    | 'corrupt-data'        // undecryptable/structurally broken at-rest payload
    | 'unsupported-runtime' // envelope from the future, or missing browser API
    | 'unsupported'         // this backend cannot perform this operation

/**
 * Errors are two-channel: orchestration switches on `code` (retry vs lock vs
 * surface), UI switches on `cause` when it needs the specific message or an
 * instanceof branch. Adapters and decorators always attach the original typed
 * error (crypto2 / outline error classes) as `cause`, so existing UI branches
 * keep working — that is what makes the mapping behaviour-preserving.
 */
export class StoreError extends Error {
    readonly code: StoreErrorCode
    override readonly cause?: unknown

    constructor(code: StoreErrorCode, message: string, cause?: unknown) {
        super(message)
        this.name = 'StoreError'
        this.code = code
        this.cause = cause
    }
}

// ── Capabilities (§4.1) ──────────────────────────────────────────────────────

export interface StoreCapabilities {
    /**
     * Durability of the backend:
     * - 'always'  — survives reload/eviction by design (File, Remote)
     * - 'prompt'  — evictable unless the user grants persistence via
     *               navigator.storage.persist() (Local; the prompt flow hangs
     *               off this value and nowhere else — stores never call it)
     * - 'never'   — lost on reload (Memory)
     */
    durable: 'always' | 'prompt' | 'never'
    /** Data is encrypted at rest. Drives the lock screen. */
    encrypted: boolean
    /** Requires a signed-in user; pairs with an AuthProvider. */
    authenticated: boolean
    /** Cheap change detection available (head). */
    changeDetection: boolean
    /**
     * false ⇒ the backend cannot run in this browser (File mode without
     * showSaveFilePicker — Firefox/Safari). Mode selection filters on this
     * before construction; constructors never throw for environment reasons.
     */
    available: boolean
}

// ── DocStore — the public, model-level contract (§4.1) ───────────────────────

export interface DocStore {
    /** The stored document, or null when the store holds nothing. */
    read(): Promise<OutlineDoc | null>

    /**
     * Upsert the document. Must refresh the change token. Resolves with the
     * new head token — the value a subsequent head() would report — or null
     * when the backend tracks no token. This lets the orchestration refresh
     * its last-seen token from the write itself: no extra round-trip, and no
     * mistaking the device's own push for a remote change.
     */
    write(doc: OutlineDoc): Promise<string | null>

    /** Delete the stored document ("purge my server/local data"). */
    clear(): Promise<void>

    /**
     * Cheap existence probe. MUST NOT require an unlocked session or a
     * passphrase (used by boot before the lock screen is shown). For
     * authenticated stores this may require a signed-in user.
     */
    exists(): Promise<boolean>

    /**
     * Opaque change token: MUST differ whenever the stored document changed,
     * MUST be stable when it did not. Consumers only compare for inequality;
     * they never interpret the value. Absent ⇒ no cheap change detection.
     */
    head?(): Promise<string | null>

    /** Encrypted stores additionally expose the lock lifecycle. */
    unlock?(passphrase: string): Promise<void>   // throws StoreError('wrong-key')
    lock?(): Promise<void>

    capabilities: StoreCapabilities
}

// ── StringStore — string payloads, the crypto decorator's upper edge (§4.3) ──

/**
 * String-level mirror of DocStore: identical lifecycle, string payloads.
 * Returned by encrypted() and by plain string stores (memory, file);
 * codecStore() (docCodec.ts) lifts a StringStore into a DocStore. The crypto
 * decorator sits BELOW the codec and only ever sees strings — it knows no
 * document format.
 */
export interface StringStore {
    read(): Promise<string | null>
    /** Upsert; resolves with the new head token, or null when untracked. */
    write(text: string): Promise<string | null>
    clear(): Promise<void>
    exists(): Promise<boolean>
    head?(): Promise<string | null>
    /** Encrypted stores verify the passphrase by decrypting (one round-trip)
     * and resolve with an UnlockResult; plain stores never expose unlock. */
    unlock?(passphrase: string): Promise<UnlockResult | void>
    lock?(): Promise<void>
    capabilities: StoreCapabilities
}

// ── RawStore — the backend adapter contract, below the crypto line (§4.2) ────

export interface RawRecord {
    /** Opaque payload: ciphertext envelope for encrypted stores, plain text otherwise. */
    data: string
    /** Opaque auxiliary field the encrypted decorator uses (the salt). */
    salt?: string
    /**
     * Modification stamp assigned by the adapter (Supabase today: client clock
     * through the adapter — documented limitation, docs §5).
     */
    updatedAt?: string
}

export interface RawStore {
    /** The backend's capability descriptor (encrypted is false at this level;
     * the encrypted() decorator is what sets it). */
    readonly capabilities: StoreCapabilities
    readRaw(): Promise<RawRecord | null>           // null = no record
    /**
     * Upsert; the adapter assigns updatedAt (Supabase: client clock). Resolves
     * with the new head token (the value head() would now report), or null if
     * untracked. Adapters must not require read-before-write.
     */
    writeRaw(record: RawRecord): Promise<string | null>
    clearRaw(): Promise<void>
    /** Cheap existence probe — no key or session required. */
    exists(): Promise<boolean>
    head?(): Promise<string | null>
    /**
     * Push-based change notification (reserved, PR 4). Emits the new head
     * token on remote change; the returned function unsubscribes. Absent ⇒
     * polling only.
     */
    watch?(emit: (token: string) => void): () => void
}

// ── Unlock result (§4.3) ─────────────────────────────────────────────────

/** What a successful encrypted unlock reports: the decrypted at-rest text
 * (null when the store was empty — first-time setup adoption) and the
 * downloaded record's own change token, so the orchestration can adopt exactly
 * the state it loaded. One round-trip: no separate read. */
export interface UnlockResult {
    text: string | null
    headToken: string | null
}

// ── Backend registry (§13 OQ 3, PR 3) ───────────────────────────────────────

/** The sync backends the app can talk to. There is no user-facing choice: the
 * server is TrailBase on the origin serving the app (`trail run --public-dir
 * dist`), resolved automatically in the remote flow. 'supabase'/'virgulas'
 * exist for the legacy hosted Supabase deployment and its existing users.
 * - 'trailbase' — a TrailBase instance; url '' (the default) = the app's own origin
 * - 'supabase'  — a Supabase project (url + anon key), for legacy/existing sessions
 * - 'virgulas'  — the hosted Supabase deployment (the legacy read-through default)
 */
export type BackendKind = 'virgulas' | 'supabase' | 'trailbase'

export interface BackendConfig {
    backend: BackendKind
    url?: string
    key?: string
}

/** The hosted fallback for deployments without TrailBase at their origin (the
 * current static hosting): the managed Supabase project. When the app itself
 * is served by TrailBase, the same-origin probe wins and this is never used. */
export const HOSTED_BACKEND: BackendConfig = {
    backend: 'virgulas',
    url: 'https://gcpdascpdrakecpknrtt.supabase.co',
    key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc'
}

/** The default backend: TrailBase on the app's own origin. */
export const DEFAULT_BACKEND: BackendConfig = { backend: 'trailbase', url: '' }

/**
 * Parses the persisted backend config slot. Backwards compatible with both
 * legacy shapes: the pre-seam `supabaseconfig` value `{ url, key }` (a custom
 * Supabase when the url differs from the hosted default, the hosted server
 * otherwise) and the current `{ backend, url?, key? }`. An empty/absent
 * TrailBase url means the app's own origin.
 */
export function parseBackendConfig(raw: string | null | undefined): BackendConfig {
    if (raw) {
        try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
                if (parsed.backend === 'trailbase' || parsed.backend === 'supabase' || parsed.backend === 'virgulas') {
                    return {
                        backend: parsed.backend,
                        url: typeof parsed.url === 'string' ? parsed.url : (parsed.backend === 'trailbase' ? '' : undefined),
                        key: typeof parsed.key === 'string' && parsed.key ? parsed.key : undefined
                    }
                }
                // Legacy `{ url, key }` shape (the old supabaseconfig):
                const url = typeof parsed.url === 'string' ? parsed.url : undefined
                if (url) {
                    if (url === HOSTED_BACKEND.url) return { backend: 'virgulas', url: HOSTED_BACKEND.url, key: HOSTED_BACKEND.key }
                    const key = typeof parsed.key === 'string' ? parsed.key : undefined
                    return { backend: 'supabase', url, key }
                }
            }
        } catch { /* fall through to the default */ }
    }
    return { ...DEFAULT_BACKEND }
}

// ── AuthProvider — complete auth contract (§4.5) ─────────────────────────────

export interface AuthUser {
    id: string
    email?: string
    emailVerified?: boolean
}

export interface SignUpResult {
    user: AuthUser
    /** false ⇒ "confirmation required, not signed in yet" — data, not a comment. */
    session: boolean
}

export interface AuthProvider {
    signUp(email: string, password: string): Promise<SignUpResult>
    signIn(email: string, password: string): Promise<AuthUser>
    signOut(): Promise<void>
    /** Server-verified probe (network round-trip on Supabase): boot and session
     * checks use it; the write path must not. */
    getUser(): Promise<AuthUser | null>

    updatePassword(newPassword: string): Promise<void>
    updateEmail(newEmail: string): Promise<void>

    /**
     * Self-service auth-account deletion — optional; presence is the
     * capability. Supabase: absent (deleting auth.users needs the service
     * role, which the browser never holds). No password/re-auth parameter:
     * re-verification is a product decision requiring a SPEC change, not
     * something to invent here.
     */
    deleteUser?(): Promise<void>

    requestPasswordReset?(email: string): Promise<void>   // capability-gated

    capabilities: {
        passwordReset: boolean
        oauth: boolean
    }
}
