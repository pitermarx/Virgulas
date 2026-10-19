// TrailBase adapter suite (PR 3): auth flows against a fake fetch, the
// 401 → refresh → retry cycle, record mapping, error mapping, and the
// deleteUser capability (TrailBase supports self-service account deletion).

import { trailbaseRaw, trailbaseAuth } from '../../../source/js/trailbaseBackend.js'
import { StoreError } from '../../../source/js/storage.js'
import { store } from '../../../source/js/utils.js'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const CONFIG = { backend: 'trailbase' as const, url: 'https://trail.example.com' }

// ─── fake fetch ──────────────────────────────────────────────────────────────

interface FetchCall {
    url: string
    method: string
    body: any
    authHeader?: string
}

interface FakeRoute {
    // Returns the response; when a function, receives the parsed request body.
    respond: (body: any, call: FetchCall) => { status: number; json?: any } | { status: number; json?: any }[]
}

function fakeFetch(routes: Array<(call: FetchCall) => { status: number; json?: any } | null> = []) {
    const calls: FetchCall[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
        const call: FetchCall = {
            url: String(input),
            method: init?.method || 'GET',
            body: init?.body ? JSON.parse(init.body) : null,
            authHeader: init?.headers instanceof Headers ? (init.headers.get('Authorization') ?? undefined) : (init?.headers?.Authorization ?? undefined)
        }
        calls.push(call)
        for (const route of routes) {
            const result = route(call)
            if (result) {
                return new Response(result.json ? JSON.stringify(result.json) : null, { status: result.status })
            }
        }
        return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    return {
        calls,
        routes,
        restore() { globalThis.fetch = original }
    }
}

function seedSession(authToken = 'tok-1', refreshToken = 'ref-1') {
    store.backendSession.set(JSON.stringify({
        tokens: { auth_token: authToken, refresh_token: refreshToken },
        userId: 'user-1',
        email: 'u@example.com'
    }))
}

async function expectStoreError(fn: () => Promise<unknown>, code: string, label: string): Promise<StoreError> {
    let threw: any = null
    try { await fn() } catch (e) { threw = e }
    assert(threw instanceof StoreError, `${label}: threw StoreError (got ${threw?.constructor?.name})`)
    assertEqual(threw.code, code, `${label}: code`)
    return threw
}

const JSON_OK = { status: 200, json: { ok: true } }

// ─── auth ────────────────────────────────────────────────────────────────────

section('trailbaseAuth — flows')

await test('login exchanges credentials for tokens, persists the session and reports the user', async () => {
    const fetcher = fakeFetch([
        (call) => call.url.endsWith('/api/auth/v1/login')
            ? { status: 200, json: { auth_token: 'a.b.c', refresh_token: 'r-1', csrf_token: 'c-1' } }
            : null
    ])
    try {
        const jwt = 'h.' + btoa(JSON.stringify({ sub: 'user-7', email: 'u@example.com' })) + '.s'
        fetcher.routes.length = 0
        fetcher.routes.push((call) => call.url.endsWith('/api/auth/v1/login')
            ? { status: 200, json: { auth_token: jwt, refresh_token: 'r-1' } }
            : null)

        const auth = trailbaseAuth(CONFIG)
        const user = await auth.signIn('u@example.com', 'pw-123456')

        assertEqual(user.id, 'user-7', 'user id from the JWT sub claim')
        assertEqual(user.email, 'u@example.com', 'email from the JWT')
        const persisted = JSON.parse(store.backendSession.get()!)
        assertEqual(persisted.userId, 'user-7', 'session persisted (Rule 7: via a store slot)')
        assertEqual(persisted.tokens.auth_token, jwt, 'auth token persisted')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('register reports session: false and never signs in (anti-enumeration)', async () => {
    let loginCalled = false
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/auth/v1/register')) {
                assertEqual(call.body.password_repeat, call.body.password, 'password_repeat sent')
                return { status: 200, json: {} }
            }
            if (call.url.endsWith('/api/auth/v1/login')) loginCalled = true
            return null
        }
    ])
    try {
        const auth = trailbaseAuth(CONFIG)
        const result = await auth.signUp('u@example.com', 'pw-123456')
        assertEqual(result.session, false, 'register never signs in')
        assertEqual(loginCalled, false, 'no login attempt after register')
        assertEqual(result.user.email, 'u@example.com', 'user email echoed')
    } finally {
        fetcher.restore()
    }
})

await test('getUser is the server-verified probe: validates via /status', async () => {
    seedSession()
    let statusCalled = false
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/auth/v1/status')) {
                statusCalled = true
                assert(!!call.authHeader?.startsWith('Bearer tok-1'), 'Bearer auth attached')
                return { status: 200, json: {} }
            }
            return null
        }
    ])
    try {
        const auth = trailbaseAuth(CONFIG)
        const user = await auth.getUser()
        assert(statusCalled, 'status endpoint used (server-verified)')
        assertEqual(user?.id, 'user-1', 'user from the persisted session')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('getUser returns null without a session', async () => {
    store.backendSession.del()
    const fetcher = fakeFetch([])
    try {
        const auth = trailbaseAuth(CONFIG)
        assertEqual(await auth.getUser(), null, 'no session → null')
    } finally {
        fetcher.restore()
    }
})

await test('deleteUser is present (TrailBase supports self-service deletion)', async () => {
    seedSession()
    let deleteCalled = false
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/auth/v1/delete')) { deleteCalled = true; return { status: 200, json: {} } }
            return null
        }
    ])
    try {
        const auth = trailbaseAuth(CONFIG)
        await auth.deleteUser!()
        assert(deleteCalled, 'POST /api/auth/v1/delete issued')
        assertEqual(store.backendSession.get(), null, 'session dropped after deletion')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

// ─── 401 → refresh → retry ───────────────────────────────────────────────────

section('trailbaseAuth — token refresh')

await test('a 401 refreshes the token once and retries; a failed refresh surfaces unauthenticated', async () => {
    seedSession('stale-token', 'ref-1')
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/records/v1/outlines?_limit=1')) {
                // 401 for the stale token, 200 after the refresh
                return call.authHeader?.includes('fresh-token') ? { status: 200, json: { records: [] } } : { status: 401, json: {} }
            }
            if (call.url.endsWith('/api/auth/v1/refresh')) {
                assertEqual(call.body.refresh_token, 'ref-1', 'refresh token sent')
                return { status: 200, json: { auth_token: 'fresh-token', refresh_token: 'ref-2' } }
            }
            return null
        }
    ])
    try {
        const raw = trailbaseRaw(CONFIG)
        const record = await raw.readRaw()
        assertEqual(record, null, 'empty list reads null after the refresh+retry')
        const persisted = JSON.parse(store.backendSession.get()!)
        assertEqual(persisted.tokens.auth_token, 'fresh-token', 'refreshed tokens persisted')
        assertEqual(persisted.tokens.refresh_token, 'ref-2', 'rotated refresh token persisted')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('a revoked refresh token surfaces unauthenticated', async () => {
    seedSession('stale-token', 'ref-dead')
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/records/v1/outlines?_limit=1')) {
                return call.authHeader?.includes('fresh') ? { status: 200, json: { records: [] } } : { status: 401, json: {} }
            }
            if (call.url.endsWith('/api/auth/v1/refresh')) return { status: 401, json: { error: 'revoked' } }
            return null
        }
    ])
    try {
        const raw = trailbaseRaw(CONFIG)
        await expectStoreError(() => raw.readRaw(), 'unauthenticated', 'revoked session')
        assertEqual(store.backendSession.get(), null, 'session dropped')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

// ─── records ─────────────────────────────────────────────────────────────────

section('trailbaseRaw — records')

await test('writeRaw creates when no row exists (user supplied, ACL-verified) and updates when it does', async () => {
    seedSession()
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/records/v1/outlines?_limit=1')) {
                return { status: 200, json: { records: [] } }   // no row yet
            }
            if (call.url.endsWith('/api/records/v1/outlines') && call.method === 'POST') {
                assertEqual(call.body.user, 'user-1', 'owner supplied (ACL verifies against the JWT)')
                assertEqual(call.body.data, 'the envelope', 'data sent')
                return { status: 200, json: { ids: [42] } }
            }
            return null
        }
    ])
    try {
        const raw = trailbaseRaw(CONFIG)
        const token = await raw.writeRaw({ data: 'the envelope', salt: 'salt-x' })
        assert(typeof token === 'string' && token.length > 0, 'write resolves with the client stamp')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('writeRaw patches the existing row (upsert semantics, no read-before-write by the consumer)', async () => {
    seedSession()
    let patched = false
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/records/v1/outlines?_limit=1')) {
                return { status: 200, json: { records: [{ id: 42, data: 'old', salt: 's', updated_at: 'old-stamp' }] } }
            }
            if (call.url.endsWith('/api/records/v1/outlines/42') && call.method === 'PATCH') {
                patched = true
                assertEqual(call.body.data, 'new envelope', 'patch body')
                return { status: 200, json: { record: { id: 42 } } }
            }
            return null
        }
    ])
    try {
        const raw = trailbaseRaw(CONFIG)
        const token = await raw.writeRaw({ data: 'new envelope', salt: 's' })
        assert(patched, 'PATCH issued to the existing row id')
        assert(typeof token === 'string', 'token resolved')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('readRaw maps the record fields; head/exists track the row', async () => {
    seedSession()
    const fetcher = fakeFetch([
        (call) => call.url.endsWith('/api/records/v1/outlines?_limit=1')
            ? { status: 200, json: { records: [{ id: 7, data: 'envelope-bytes', salt: 'salt-9', updated_at: 'stamp-1' }] } }
            : null
    ])
    try {
        const raw = trailbaseRaw(CONFIG)
        const record = await raw.readRaw()
        assertEqual(record?.data, 'envelope-bytes', 'data mapped')
        assertEqual(record?.salt, 'salt-9', 'salt mapped')
        assertEqual(record?.updatedAt, 'stamp-1', 'updatedAt mapped')
        assertEqual(await raw.head!(), 'stamp-1', 'head = the row stamp')
        assertEqual(await raw.exists(), true, 'exists')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('clearRaw deletes the row; exists/head read as empty afterwards', async () => {
    seedSession()
    let deleted = false
    const fetcher = fakeFetch([
        (call) => {
            if (call.url.endsWith('/api/records/v1/outlines?_limit=1')) {
                return deleted ? { status: 200, json: { records: [] } } : { status: 200, json: { records: [{ id: 7, data: 'x', updated_at: 't' }] } }
            }
            if (call.url.endsWith('/api/records/v1/outlines/7') && call.method === 'DELETE') {
                deleted = true
                return { status: 200, json: {} }
            }
            return null
        }
    ])
    try {
        const raw = trailbaseRaw(CONFIG)
        await raw.clearRaw()
        assert(deleted, 'DELETE issued to the row id')
        assertEqual(await raw.exists(), false, 'exists false after clear')
        assertEqual(await raw.head!(), null, 'head null after clear')
    } finally {
        fetcher.restore()
        store.backendSession.del()
    }
})

await test('a transport failure maps to network with the URL hint', async () => {
    seedSession()
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    try {
        const raw = trailbaseRaw(CONFIG)
        await expectStoreError(() => raw.readRaw(), 'network', 'unreachable instance')
    } finally {
        globalThis.fetch = original
        store.backendSession.del()
    }
})

await test('capabilities describe the backend honestly', () => {
    const caps = trailbaseRaw(CONFIG).capabilities
    assertEqual(caps.durable, 'always', 'server-side durability')
    assertEqual(caps.authenticated, true, 'requires sign-in')
    assertEqual(caps.encrypted, false, 'raw level is not encrypted')
    const auth = trailbaseAuth(CONFIG)
    assertEqual('deleteUser' in auth, true, 'deleteUser present (unlike Supabase)')
    assertEqual(auth.capabilities.passwordReset, false, 'passwordReset capability')
})
