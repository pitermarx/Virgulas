// Supabase backend adapter (docs/storage-interface.md §4.2/§4.5, rollout PR 2b).
// RawStore + AuthProvider over @supabase/supabase-js. Below both the codec and
// the crypto line: it stores opaque records and never sees a document.
//
// Identity binding (§4.2): orchestration never sees or supplies a user id —
// the adapter sources it from the *locally cached session*
// (`auth.getSession()`, no network round-trip; the pre-seam code ran
// `auth.getUser()` on every push) and RLS `with check (auth.uid() = user_id)`
// server-verifies that the value matches the JWT, so it cannot be forged.
// Removing the column from the wire entirely needs a migration and rides with
// the deferred follow-up (§12).
//
// `updated_at` is client-supplied (unchanged schema): the head() token inherits
// client-clock trust — pre-existing, documented in §5. The seam isolates that
// weakness here so the follow-up fix has a single touch point.
//
// The client loader lives here: a dynamic import so TrailBase, local, memory and
// file users never download the ~220 KB chunk, plus the __TEST_HOOKS__ window
// seam. `sync.ts` resolves the backend and uses this module; nothing else loads
// the Supabase client.

import { HOSTED_BACKEND, StoreError, type AuthProvider, type AuthUser, type BackendConfig, type RawRecord, type RawStore } from './storage.js'
import { legacySlot, store, type StoreSlot } from './utils.js'

// ── Client loading ───────────────────────────────────────────────────────────

type ClientFactory = (url: string, key: string, options?: any) => any

/** The subset of the Web Storage API supabase-js uses for the auth session. */
export interface SupabaseAuthStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

type AuthStorageMap = Record<string, string>

function readAuthStorageMap(sessionSlot: StoreSlot): AuthStorageMap {
    const raw = sessionSlot.get()
    if (!raw) return {}
    try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const map: AuthStorageMap = Object.create(null)
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') map[key] = value
        }
        return map
    } catch {
        return {}
    }
}

function writeAuthStorageMap(sessionSlot: StoreSlot, map: AuthStorageMap) {
    if (Object.keys(map).length === 0) sessionSlot.del()
    else sessionSlot.set(JSON.stringify(map))
}

/**
 * supabase-js persists the session (and, depending on options, the user and
 * PKCE verifier) under sibling keys. A single store slot cannot hold them as
 * separate localStorage entries, so the adapter keeps the SDK's key/value
 * pairs in one JSON map inside `store.supabaseSession`. TrailBase's session
 * keeps its own `store.backendSession` slot (Rule 7, docs §4.5).
 */
export function supabaseAuthStorage(sessionSlot: StoreSlot = store.supabaseSession): SupabaseAuthStorage {
    return {
        getItem(key: string): string | null {
            const map = readAuthStorageMap(sessionSlot)
            return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null
        },
        setItem(key: string, value: string): void {
            const map = readAuthStorageMap(sessionSlot)
            map[key] = value
            writeAuthStorageMap(sessionSlot, map)
        },
        removeItem(key: string): void {
            const map = readAuthStorageMap(sessionSlot)
            if (!Object.prototype.hasOwnProperty.call(map, key)) return
            delete map[key]
            writeAuthStorageMap(sessionSlot, map)
        }
    }
}

/** The SDK's default session key for a project URL (`sb-<ref>-auth-token`). */
function defaultAuthStorageKey(url: string): string | null {
    try {
        return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
    } catch {
        return null
    }
}

/**
 * Adopts the token an older build let supabase-js write directly into
 * localStorage, then removes the old key. Without this, upgrading would sign
 * every existing Supabase user out and leave the token behind on the device.
 */
function adoptLegacyAuthSession(url: string, storage: SupabaseAuthStorage) {
    const key = defaultAuthStorageKey(url)
    if (!key) return
    const legacy = legacySlot(key)
    const value = legacy.get()
    if (value === null) return
    if (storage.getItem(key) === null) storage.setItem(key, value)
    legacy.del()
}

/** Options passed to `createClient`: the bundled client and the test seam both
 * go through this, so the auth session always lands in the store slot. */
export function supabaseClientOptions(storage: SupabaseAuthStorage = supabaseAuthStorage()) {
    return {
        realtime: { enabled: false },
        auth: { storage }
    }
}

/** Builds the SDK client through the injected factory, wiring the store-backed
 * auth persistence before the client can read a session. */
export function createSupabaseClient(factory: ClientFactory, url: string, key: string): any {
    const storage = supabaseAuthStorage()
    adoptLegacyAuthSession(url, storage)
    return factory(url, key, supabaseClientOptions(storage))
}

let _clientFactory: ClientFactory | null = null

async function loadClientFactory(): Promise<ClientFactory> {
    if (_clientFactory) return _clientFactory

    // Test seam. `__TEST_HOOKS__` is a build-time constant: `true` only in the
    // Playwright bundle, `false` in production, where this branch is dropped
    // entirely. Without the gate, any same-origin script could substitute the
    // Supabase client and capture sign-in credentials or the session token.
    if (typeof __TEST_HOOKS__ !== 'undefined' && __TEST_HOOKS__ && typeof window.supabase?.createClient === 'function') {
        _clientFactory = window.supabase.createClient as ClientFactory
        return _clientFactory
    }

    const { createClient } = await import('@supabase/supabase-js')
    _clientFactory = createClient as ClientFactory
    return _clientFactory
}

let _client: any = null
let _clientConfig: { url: string; key: string } | null = null

/** Builds (or reuses) the client for the given backend config. A config change
 * (the user switching instances) rebuilds the client. The auth session always
 * goes through `createSupabaseClient`, so supabase-js never writes its own
 * `sb-*-auth-token` key into localStorage (Rule 7, docs §4.5). */
export async function ensureSupabaseClient(config: BackendConfig = HOSTED_BACKEND): Promise<any> {
    const url = config.url || HOSTED_BACKEND.url!
    const key = config.key || HOSTED_BACKEND.key!
    if (_client && _clientConfig && _clientConfig.url === url && _clientConfig.key === key) return _client
    const factory = await loadClientFactory()
    _client = createSupabaseClient(factory, url, key)
    _clientConfig = { url, key }
    return _client
}

// ── Error mapping (§4.4) ─────────────────────────────────────────────────────

/** Supabase `PGRST116` (row not found) is the `not-found` code. */
function isRowNotFound(error: any): boolean {
    return error?.code === 'PGRST116'
}

function mapSupabaseError(error: any): StoreError {
    if (isRowNotFound(error)) {
        return new StoreError('not-found', 'No stored document on the server.', error)
    }
    // The provider's own message is preserved (two-channel): the lock screen
    // surfaces it verbatim for auth errors like invalid credentials.
    const message = error?.message || 'The server could not be reached.'
    const status = error?.status
    if (status === 401 || status === 403) {
        return new StoreError('unauthenticated', message, error)
    }
    return new StoreError('network', message, error)
}

/** The locally cached session user (no network round-trip) — the uid source. */
async function cachedSessionUser(client: any): Promise<any | null> {
    const { data, error } = await client.auth.getSession()
    if (error) throw mapSupabaseError(error)
    return data?.session?.user ?? null
}

// ── RawStore (§4.2) ──────────────────────────────────────────────────────────

export function supabaseRaw(client: any): RawStore {
    async function withTable<T = any>(fn: (table: any) => Promise<{ data: T; error: any }>): Promise<T> {
        const { data, error } = await fn(client.from('outlines'))
        if (error) throw mapSupabaseError(error)
        return data
    }

    async function head(): Promise<string | null> {
        try {
            const row = await withTable<any>((t) => t.select('updated_at').single())
            return row?.updated_at ?? null
        } catch (error) {
            if (error instanceof StoreError && error.code === 'not-found') return null
            throw error
        }
    }

    return {
        capabilities: {
            durable: 'always',
            encrypted: false,
            authenticated: true,
            changeDetection: true,
            available: true
        },

        async readRaw(): Promise<RawRecord | null> {
            try {
                const row = await withTable<any>((t) => t.select('salt, data, updated_at').single())
                if (!row) return null
                return { data: row.data, salt: row.salt ?? undefined, updatedAt: row.updated_at ?? undefined }
            } catch (error) {
                if (error instanceof StoreError && error.code === 'not-found') return null
                throw error
            }
        },

        async writeRaw(record: RawRecord): Promise<string | null> {
            const user = await cachedSessionUser(client)
            if (!user?.id) {
                throw new StoreError('unauthenticated', 'Not signed in. Sign in again before saving to the server.')
            }
            // Client-supplied stamp — documented limitation (§5): not monotone
            // across devices, forgeable by a compromised client. The follow-up
            // moves it server-side; the adapter is the single touch point.
            const updatedAt = record.updatedAt || new Date().toISOString()
            await withTable((t) => t.upsert(
                { data: record.data, salt: record.salt, updated_at: updatedAt, user_id: user.id },
                { onConflict: 'user_id' }
            ))
            // The value head() would now report — the poller adopts its own
            // push from this, so it never re-pulls its own update.
            return updatedAt
        },

        async clearRaw(): Promise<void> {
            const user = await cachedSessionUser(client)
            if (!user?.id) {
                throw new StoreError('unauthenticated', 'Not signed in. Sign in again before deleting your data.')
            }
            await withTable((t) => t.delete().eq('user_id', user.id))
        },

        async exists(): Promise<boolean> {
            try {
                return (await head()) !== null
            } catch (error) {
                if (error instanceof StoreError && error.code === 'not-found') return false
                throw error
            }
        },

        head
    }
}

// ── AuthProvider (§4.5) ──────────────────────────────────────────────────────

function toAuthUser(user: any): AuthUser {
    if (!user) throw new StoreError('unauthenticated', 'No user was returned.')
    return {
        id: user.id,
        email: user.email ?? undefined,
        emailVerified: user.email_confirmed_at != null
    }
}

export function supabaseAuth(client: any): AuthProvider {
    return {
        async signUp(email, password) {
            const { data, error } = await client.auth.signUp({ email, password })
            if (error) throw mapSupabaseError(error)
            return { user: toAuthUser(data?.user), session: !!data?.session }
        },

        async signIn(email, password) {
            const { data, error } = await client.auth.signInWithPassword({ email, password })
            if (error) throw mapSupabaseError(error)
            return toAuthUser(data?.user)
        },

        async signOut() {
            await client.auth.signOut()
        },

        async getUser(): Promise<AuthUser | null> {
            const { data, error } = await client.auth.getUser()
            if (error) return null
            return data?.user ? toAuthUser(data.user) : null
        },

        async updatePassword(newPassword) {
            const { error } = await client.auth.updateUser({ password: newPassword })
            if (error) throw mapSupabaseError(error)
        },

        async updateEmail(newEmail) {
            const { error } = await client.auth.updateUser({ email: newEmail })
            if (error) throw mapSupabaseError(error)
        },

        /** Supabase's self-service reset: the email links back to this app's
         * origin, where supabase-js consumes the recovery token and the user
         * sets a new password via Options → Account password (updatePassword).
         * Anti-enumeration: no error when the account does not exist. */
        async requestPasswordReset(email: string): Promise<void> {
            const { error } = await client.auth.resetPasswordForEmail(email, {
                redirectTo: window.location.origin
            })
            if (error) throw mapSupabaseError(error)
        },

        // deleteUser is deliberately ABSENT: deleting `auth.users` needs the
        // service role, which the browser never holds. Presence is the
        // capability — the account-deletion flow branches on it for its
        // "the auth record survives" caveat.

        capabilities: {
            passwordReset: true,
            oauth: false
        }
    }
}
