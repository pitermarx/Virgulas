// TrailBase backend adapter (docs/storage-interface.md §4.2/§4.5, rollout PR 3).
// RawStore + AuthProvider over a TrailBase instance's JSON APIs — pure fetch,
// no SDK (Rule 6: no new dependencies).
//
// TrailBase model: JWT auth tokens (~1h) + long-lived opaque refresh tokens;
// requests attach `Authorization: Bearer <auth_token>`; a 401 is answered by
// one token refresh + one retry before surfacing unauthenticated. Records are
// exposed through a Record API over an `outlines` table whose ACL scopes every
// row to its owner (`create: _REQ_.user = _USER_.id`,
// `update/delete: _ROW_.user = _USER_.id`) — the client supplies `user` and the
// ACL server-verifies it against the JWT, the same trust shape as Supabase RLS.
// `updated_at` is client-supplied (the same documented limitation as Supabase,
// docs §5); the fix is the shared server-managed-stamp follow-up.
//
// Unlike Supabase, TrailBase exposes self-service account deletion
// (`POST /api/auth/v1/delete`), so this AuthProvider's `deleteUser` is PRESENT
// and the account-deletion flow can honestly remove the auth record.
//
// Setup (self-hosting): create a STRICT `outlines` table with columns
// (id, user, data, salt, updated_at) and a record API named `outlines` with
// authenticated READ/LIST/CREATE/UPDATE/DELETE and the owner ACL rules above.
// See the README's "Bring your own backend" section.

import { StoreError, type AuthProvider, type AuthUser, type BackendConfig, type RawRecord, type RawStore, type SignUpResult } from './storage.js'
import { store } from './utils.js'

const RECORD_API = 'outlines'

interface TrailbaseTokens {
    auth_token: string
    refresh_token: string | null
    csrf_token?: string | null
}

interface PersistedSession {
    tokens: TrailbaseTokens
    userId: string
    email?: string
}

// ── Session persistence (Rule 7: via a store slot) ───────────────────────────

function readSession(): PersistedSession | null {
    try {
        const raw = store.backendSession.get()
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed?.tokens?.auth_token || !parsed?.userId) return null
        return parsed as PersistedSession
    } catch {
        return null
    }
}

function writeSession(session: PersistedSession | null) {
    if (session) store.backendSession.set(JSON.stringify(session))
    else store.backendSession.del()
}

// ── JWT helpers (the claims carry the user identity) ─────────────────────────

function decodeJwtClaims(jwt: string): { sub?: string; email?: string } | null {
    try {
        const payload = jwt.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
        return JSON.parse(atob(padded))
    } catch {
        return null
    }
}

// ── Fetch plumbing ───────────────────────────────────────────────────────────

interface TrailbaseResponse {
    status: number
    json: any
}

function mapTrailbaseError(status: number, json: any): StoreError {
    const message = json?.error || json?.message || `The TrailBase instance returned ${status}.`
    if (status === 401) return new StoreError('unauthenticated', message, json)
    if (status === 403) return new StoreError('unauthenticated', message, json)
    if (status === 404) return new StoreError('not-found', message, json)
    return new StoreError('network', message, json)
}

async function parseJson(response: Response): Promise<any> {
    try {
        return await response.json()
    } catch {
        return null
    }
}

async function rawFetch(config: BackendConfig, path: string, init: RequestInit): Promise<TrailbaseResponse> {
    const base = (config.url || '').replace(/\/+$/, '')
    let response: Response
    try {
        response = await fetch(`${base}${path}`, init)
    } catch (error) {
        throw new StoreError('network', 'The TrailBase instance could not be reached. Check the instance URL.', error)
    }
    return { status: response.status, json: await parseJson(response) }
}

/** Authenticated fetch with one transparent 401 → refresh → retry cycle. */
async function authedFetch(config: BackendConfig, path: string, init: RequestInit): Promise<TrailbaseResponse> {
    const session = readSession()
    if (!session) throw new StoreError('unauthenticated', 'Not signed in.')

    const base = (config.url || '').replace(/\/+$/, '')
    const doFetch = async (authToken: string): Promise<TrailbaseResponse> => {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${authToken}`)
        try {
            const response = await fetch(`${base}${path}`, { ...init, headers })
            return { status: response.status, json: await parseJson(response) }
        } catch (error) {
            throw new StoreError('network', 'The TrailBase instance could not be reached. Check the instance URL.', error)
        }
    }

    let response = await doFetch(session.tokens.auth_token)
    if (response.status === 401 && session.tokens.refresh_token) {
        const refreshed = await rawFetch(config, '/api/auth/v1/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.tokens.refresh_token })
        })
        if (refreshed.status === 200 && refreshed.json?.auth_token) {
            session.tokens = {
                auth_token: refreshed.json.auth_token,
                refresh_token: refreshed.json.refresh_token ?? session.tokens.refresh_token,
                csrf_token: refreshed.json.csrf_token ?? session.tokens.csrf_token
            }
            writeSession(session)
            response = await doFetch(session.tokens.auth_token)
        } else {
            // The refresh token is revoked or expired: the session is over.
            writeSession(null)
            throw new StoreError('unauthenticated', 'The session expired. Sign in again.')
        }
    }
    return response
}

// ── RawStore (§4.2) ──────────────────────────────────────────────────────────

/** Lists the signed-in user's own outlines rows (the ACL scopes the list). */
async function listOwn(config: BackendConfig): Promise<any | null> {
    const response = await authedFetch(config, `/api/records/v1/${RECORD_API}?_limit=1`, { method: 'GET' })
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) throw mapTrailbaseError(response.status, response.json)
    if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
    const records = Array.isArray(response.json?.records) ? response.json.records : Array.isArray(response.json) ? response.json : []
    return records[0] ?? null
}

export function trailbaseRaw(config: BackendConfig): RawStore {
    return {
        capabilities: {
            durable: 'always',
            encrypted: false,
            authenticated: true,
            changeDetection: true,
            available: true
        },

        async readRaw(): Promise<RawRecord | null> {
            const record = await listOwn(config)
            if (!record) return null
            return {
                data: record.data,
                salt: record.salt ?? undefined,
                updatedAt: record.updated_at ?? undefined
            }
        },

        async writeRaw(record: RawRecord): Promise<string | null> {
            const session = readSession()
            if (!session) throw new StoreError('unauthenticated', 'Not signed in.')
            // Client-supplied stamp — the same documented limitation as
            // Supabase (docs §5); the server-managed-stamp follow-up covers both.
            const updatedAt = record.updatedAt || new Date().toISOString()
            const existing = await listOwn(config)
            if (existing?.id !== undefined && existing?.id !== null) {
                const response = await authedFetch(config, `/api/records/v1/${RECORD_API}/${existing.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ data: record.data, salt: record.salt ?? null, updated_at: updatedAt })
                })
                if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
            } else {
                // The ACL verifies `user` against the authenticated identity.
                const response = await authedFetch(config, `/api/records/v1/${RECORD_API}`, {
                    method: 'POST',
                    body: JSON.stringify({ user: session.userId, data: record.data, salt: record.salt ?? null, updated_at: updatedAt })
                })
                if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
            }
            return updatedAt
        },

        async clearRaw(): Promise<void> {
            const existing = await listOwn(config)
            if (existing?.id === undefined || existing?.id === null) return
            const response = await authedFetch(config, `/api/records/v1/${RECORD_API}/${existing.id}`, { method: 'DELETE' })
            if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
        },

        async exists(): Promise<boolean> {
            return (await listOwn(config)) !== null
        },

        async head(): Promise<string | null> {
            const record = await listOwn(config)
            return record?.updated_at ?? null
        }
    }
}

// ── AuthProvider (§4.5) ──────────────────────────────────────────────────────

function userFromSession(session: PersistedSession): AuthUser {
    return { id: session.userId, email: session.email, emailVerified: true }
}

export function trailbaseAuth(config: BackendConfig): AuthProvider {
    return {
        async signUp(email, password): Promise<SignUpResult> {
            // TrailBase's register NEVER signs the user in, and reports success
            // even when the account already exists (anti-enumeration). The
            // user always follows up with a sign-in (session: false, §4.5).
            const response = await rawFetch(config, '/api/auth/v1/register', {
                method: 'POST',
                body: JSON.stringify({ email, password, password_repeat: password })
            })
            if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
            return { user: { id: '', email }, session: false }
        },

        async signIn(email, password): Promise<AuthUser> {
            const response = await rawFetch(config, '/api/auth/v1/login', {
                method: 'POST',
                body: JSON.stringify({ email_or_username: email, password })
            })
            if (response.status !== 200 || !response.json?.auth_token) {
                throw mapTrailbaseError(response.status, response.json)
            }
            const tokens: TrailbaseTokens = {
                auth_token: response.json.auth_token,
                refresh_token: response.json.refresh_token ?? null,
                csrf_token: response.json.csrf_token ?? null
            }
            const claims = decodeJwtClaims(tokens.auth_token)
            const session: PersistedSession = {
                tokens,
                userId: claims?.sub || email,
                email: claims?.email || email
            }
            writeSession(session)
            return userFromSession(session)
        },

        async signOut(): Promise<void> {
            const session = readSession()
            if (session?.tokens.refresh_token) {
                // Best-effort: revoke the server-side session even if the
                // request fails — the local tokens are dropped regardless.
                try {
                    await rawFetch(config, '/api/auth/v1/logout', {
                        method: 'POST',
                        body: JSON.stringify({ refresh_token: session.tokens.refresh_token })
                    })
                } catch { /* ignore */ }
            }
            writeSession(null)
        },

        async getUser(): Promise<AuthUser | null> {
            const session = readSession()
            if (!session) return null
            // Server-verified probe (§4.5): /status validates the token.
            const response = await authedFetch(config, '/api/auth/v1/status', { method: 'GET' })
            if (response.status !== 200) return null
            return userFromSession(session)
        },

        async updatePassword(newPassword): Promise<void> {
            const response = await authedFetch(config, '/api/auth/v1/change_password', {
                method: 'POST',
                body: JSON.stringify({ password: newPassword })
            })
            if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
        },

        async updateEmail(newEmail): Promise<void> {
            const response = await authedFetch(config, '/api/auth/v1/change_email/request', {
                method: 'POST',
                body: JSON.stringify({ email: newEmail })
            })
            if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
        },

        /**
         * TrailBase supports self-service account deletion — PRESENT, unlike
         * Supabase (§4.5): the account-deletion flow can honestly remove the
         * auth record on a TrailBase backend.
         */
        async deleteUser(): Promise<void> {
            const response = await authedFetch(config, '/api/auth/v1/delete', { method: 'POST' })
            if (response.status !== 200) throw mapTrailbaseError(response.status, response.json)
            writeSession(null)
        },

        capabilities: {
            passwordReset: false,
            oauth: false
        }
    }
}
