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
// The client loader duplicates sync.ts's loader (dynamic import so local/
// memory/file users never download the ~220 KB chunk, plus the __TEST_HOOKS__
// window seam). PR 2d shrinks sync.ts onto this module and the duplicate
// disappears; until then this module is dead code and sync.ts stays
// authoritative.

import { StoreError, type AuthProvider, type AuthUser, type RawRecord, type RawStore } from './storage.js'
import { store } from './utils.js'

// ── Client loading ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = { url: 'https://gcpdascpdrakecpknrtt.supabase.co', key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc' }

function readConfig() {
    try {
        const raw = store.supabase.get()
        if (!raw) return DEFAULT_CONFIG
        const parsed = JSON.parse(raw)
        const url = parsed.url || parsed.supabaseUrl
        const key = parsed.key || parsed.supabaseAnonKey
        if (!url || !key) return DEFAULT_CONFIG
        return { url, key }
    } catch {
        return DEFAULT_CONFIG
    }
}

type ClientFactory = (url: string, key: string, options?: any) => any

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

export async function ensureSupabaseClient(): Promise<any> {
    if (_client) return _client
    const factory = await loadClientFactory()
    const config = readConfig()
    _client = factory(config.url, config.key, { realtime: { enabled: false } } as any)
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
    const status = error?.status
    if (status === 401 || status === 403) {
        return new StoreError('unauthenticated', 'The session is not valid. Sign in again.', error)
    }
    return new StoreError('network', 'The server could not be reached.', error)
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

        // deleteUser is deliberately ABSENT: deleting `auth.users` needs the
        // service role, which the browser never holds. Presence is the
        // capability — the account-deletion flow branches on it for its
        // "the auth record survives" caveat.

        capabilities: {
            passwordReset: false,
            oauth: false
        }
    }
}
