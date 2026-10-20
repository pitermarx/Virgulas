// supabaseBackend adapter suite (docs/storage-interface.md §10, rollout PR 2b):
// error mapping with a fake client, cached-session uid on the write path,
// token semantics, and the AuthProvider contract including the absent
// deleteUser capability.

import { supabaseRaw, supabaseAuth } from '../../../source/js/supabaseBackend.js'
import { StoreError } from '../../../source/js/storage.js'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

// ─── fake client ─────────────────────────────────────────────────────────────

interface FakeOptions {
    row?: { salt?: string | null; data?: string; updated_at?: string } | null
    tableError?: any                  // returned by every from('outlines') call
    sessionUser?: any                  // auth.getSession() → data.session.user
    signUp?: { user: any; session: any; error?: any }
    resetError?: any                   // auth.resetPasswordForEmail → error
}

function fakeSupabaseClient(options: FakeOptions = {}) {
    const calls: any[] = []
    const resetCalls: any[] = []
    const resetError = options.resetError ?? null
    let getUserCalls = 0
    const client = {
        calls,
        auth: {
            async getSession() {
                calls.push('auth:getSession')
                return { data: { session: options.sessionUser === null ? null : { user: options.sessionUser ?? { id: 'user-1', email: 'u@example.com', email_confirmed_at: '2024-01-01' } } }, error: null }
            },
            async getUser() {
                getUserCalls += 1
                calls.push('auth:getUser')
                const user = options.sessionUser === null ? null : (options.sessionUser ?? { id: 'user-1', email: 'u@example.com' })
                return { data: { user }, error: null }
            },
            async signUp(args: any) {
                calls.push('auth:signUp')
                const result = options.signUp ?? { user: { id: 'new-user', email: args.email }, session: { token: 'x' } }
                return { data: { user: result.user, session: result.error ? null : result.session }, error: result.error ?? null }
            },
            async signInWithPassword(args: any) {
                calls.push('auth:signIn')
                return { data: { user: { id: 'user-1', email: args.email, email_confirmed_at: '2024-01-01' } }, error: null }
            },
            async signOut() {
                calls.push('auth:signOut')
                return { error: null }
            },
            async updateUser(args: any) {
                calls.push('auth:updateUser')
                return { data: { user: { id: 'user-1', ...args } }, error: null }
            },
            async resetPasswordForEmail(email: string, options: any) {
                calls.push('auth:resetPasswordForEmail')
                resetCalls.push({ email, ...options })
                return { data: {}, error: resetError }
            }
        },
        from(table: string) {
            assertEqual(table, 'outlines', 'only the outlines table is used')
            return {
                select: (columns: string) => ({
                    single: async () => {
                        calls.push(`select:${columns}`)
                        if (options.tableError) return { data: null, error: options.tableError }
                        return { data: options.row === undefined ? null : options.row, error: null }
                    }
                }),
                upsert: async (payload: any, opts: any) => {
                    calls.push(`upsert:${JSON.stringify(opts)}`)
                    if (options.tableError) return { data: null, error: options.tableError }
                    options.row = { ...payload }
                    return { data: payload, error: null }
                },
                delete: () => ({
                    eq: async (column: string, value: any) => {
                        calls.push(`delete:${column}=${value}`)
                        if (options.tableError) return { data: null, error: options.tableError }
                        options.row = null
                        return { data: null, error: null }
                    }
                })
            }
        }
    }
    return { client, getUserCallCount: () => getUserCalls, resetCalls }
}

async function expectStoreError(fn: () => Promise<unknown>, code: string, label: string): Promise<StoreError> {
    let threw: any = null
    try { await fn() } catch (e) { threw = e }
    assert(threw instanceof StoreError, `${label}: threw StoreError (got ${threw?.constructor?.name})`)
    assertEqual(threw.code, code, `${label}: code`)
    return threw
}

// ─── RawStore ────────────────────────────────────────────────────────────────

section('supabaseRaw — record mapping')

await test('readRaw maps the row to a RawRecord', async () => {
    const { client } = fakeSupabaseClient({ row: { salt: 'salt-x', data: 'envelope', updated_at: '2024-06-01T00:00:00Z' } })
    const raw = supabaseRaw(client)
    const record = await raw.readRaw()
    assertEqual(record?.data, 'envelope', 'data')
    assertEqual(record?.salt, 'salt-x', 'salt')
    assertEqual(record?.updatedAt, '2024-06-01T00:00:00Z', 'updatedAt')
})

await test('PGRST116 (row not found) reads as null, not an error', async () => {
    const { client } = fakeSupabaseClient({ tableError: { code: 'PGRST116', message: 'Row not found' } })
    const raw = supabaseRaw(client)
    assertEqual(await raw.readRaw(), null, 'readRaw null on not-found')
    assertEqual(await raw.head!(), null, 'head null on not-found')
    assertEqual(await raw.exists(), false, 'exists false on not-found')
})

await test('a 401 maps to unauthenticated; transport failures map to network', async () => {
    const unauthorized = supabaseRaw(fakeSupabaseClient({ tableError: { status: 401, message: 'JWT invalid' } }).client)
    await expectStoreError(() => unauthorized.readRaw(), 'unauthenticated', '401')

    const offline = supabaseRaw(fakeSupabaseClient({ tableError: { message: 'TypeError: Failed to fetch' } }).client)
    await expectStoreError(() => offline.readRaw(), 'network', 'transport failure')
})

section('supabaseRaw — write path')

await test('writeRaw sources the uid from the cached session, never auth.getUser()', async () => {
    const { client, getUserCallCount } = fakeSupabaseClient()
    const raw = supabaseRaw(client)
    const token = await raw.writeRaw({ data: 'envelope', salt: 'salt-x' })

    assertEqual(getUserCallCount(), 0, 'auth.getUser is never called on the write path (§4.2)')
    assertEqual((client.calls.at(-1)), 'upsert:{"onConflict":"user_id"}', 'RLS-scoped upsert')
    assertEqual(raw.readRaw !== undefined, true, 'shape')
    const row: any = { data: 'envelope', salt: 'salt-x', user_id: 'user-1', updated_at: token }
    assert(!!token, 'write resolves with a token')
    assertEqual(typeof token, 'string', 'token is the stamp')
})

await test('writeRaw resolves with the token head() reports (self-push ping-pong guard)', async () => {
    const { client } = fakeSupabaseClient()
    const raw = supabaseRaw(client)
    const token = await raw.writeRaw({ data: 'envelope', salt: 'salt-x' })
    assertEqual(await raw.head!(), token, 'head equals the write token')
})

await test('writeRaw without a signed-in session throws unauthenticated', async () => {
    const raw = supabaseRaw(fakeSupabaseClient({ sessionUser: null }).client)
    await expectStoreError(() => raw.writeRaw({ data: 'x' }), 'unauthenticated', 'no session')
})

await test('clearRaw issues the RLS-scoped row delete', async () => {
    const { client } = fakeSupabaseClient({ row: { data: 'x', updated_at: 't' } })
    const raw = supabaseRaw(client)
    await raw.clearRaw()
    assert(client.calls.includes('delete:user_id=user-1'), 'delete eq user_id')
    assertEqual(await raw.readRaw(), null, 'row gone')
})

await test('capabilities describe the backend honestly', () => {
    const caps = supabaseRaw(fakeSupabaseClient().client).capabilities
    assertEqual(caps.durable, 'always', 'server-side durability')
    assertEqual(caps.authenticated, true, 'requires sign-in')
    assertEqual(caps.encrypted, false, 'raw level is not encrypted')
    assertEqual(caps.changeDetection, true, 'head via updated_at')
})

// ─── AuthProvider ────────────────────────────────────────────────────────────

section('supabaseAuth — contract')

await test('signUp reports "confirmation required" as data, not a comment', async () => {
    const auth = supabaseAuth(fakeSupabaseClient({
        signUp: { user: { id: 'new-user', email: 'u@example.com', email_confirmed_at: null }, session: null }
    }).client)
    const result = await auth.signUp('u@example.com', 'password-123')
    assertEqual(result.session, false, 'no session when email confirmation is pending')
    assertEqual(result.user.emailVerified, false, 'email not confirmed')
})

await test('signUp with an immediate session reports session: true', async () => {
    const auth = supabaseAuth(fakeSupabaseClient({
        signUp: { user: { id: 'new-user', email: 'u@example.com', email_confirmed_at: '2024-01-01' }, session: { token: 'x' } }
    }).client)
    const result = await auth.signUp('u@example.com', 'password-123')
    assertEqual(result.session, true, 'signed in immediately')
    assertEqual(result.user.emailVerified, true, 'email confirmed')
})

await test('signIn maps to an AuthUser', async () => {
    const auth = supabaseAuth(fakeSupabaseClient().client)
    const user = await auth.signIn('u@example.com', 'password-123')
    assertEqual(user.id, 'user-1', 'user id')
    assertEqual(user.email, 'u@example.com', 'email')
    assertEqual(user.emailVerified, true, 'email verified')
})

await test('getUser is the server-verified probe and returns null without a session', async () => {
    const auth = supabaseAuth(fakeSupabaseClient({ sessionUser: null }).client)
    assertEqual(await auth.getUser(), null, 'null user')
})

await test('deleteUser is absent (presence is the capability)', () => {
    const auth = supabaseAuth(fakeSupabaseClient().client)
    assertEqual('deleteUser' in auth, false, 'deleteUser absent on Supabase (§4.5)')
    assertEqual('requestPasswordReset' in auth, true, 'password reset offered (resetPasswordForEmail)')
    assertEqual(auth.capabilities.passwordReset, true, 'passwordReset capability (resetPasswordForEmail)')
    assertEqual(auth.capabilities.oauth, false, 'oauth capability')
})

await test('updatePassword and updateEmail go through updateUser', async () => {
    const { client } = fakeSupabaseClient()
    const auth = supabaseAuth(client)
    await auth.updatePassword('new-password-123')
    await auth.updateEmail('new@example.com')
    assert(client.calls.includes('auth:updateUser'), 'updateUser called')
})

await test('requestPasswordReset sends the reset email back to the app origin', async () => {
    const { client, resetCalls } = fakeSupabaseClient()
    const auth = supabaseAuth(client)
    await auth.requestPasswordReset!('u@example.com')
    assert(client.calls.includes('auth:resetPasswordForEmail'), 'resetPasswordForEmail called')
    assertEqual(resetCalls.length, 1, 'one reset request')
    assertEqual(resetCalls[0].email, 'u@example.com', 'email passed through')
    assertEqual(resetCalls[0].redirectTo, window.location.origin, 'recovery link returns to the app')
})

await test('requestPasswordReset maps a Supabase error', async () => {
    const { client } = fakeSupabaseClient({ resetError: { message: 'rate limit reached' } })
    const auth = supabaseAuth(client)
    await expectStoreError(() => auth.requestPasswordReset!('u@example.com'), 'network', 'reset error mapped')
})
