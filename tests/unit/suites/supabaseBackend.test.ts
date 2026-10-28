import { describe, it } from 'bun:test'
// supabaseBackend adapter suite (docs/storage-interface.md §10, rollout PR 2b):
// error mapping with a fake client, cached-session uid on the write path,
// token semantics, the store-backed auth storage (§4.5), and the AuthProvider
// contract including the absent deleteUser capability.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSupabaseClient, supabaseAuthStorage, supabaseRaw, supabaseAuth } from '../../../source/js/supabaseBackend.js'
import { StoreError } from '../../../source/js/storage.js'
import { store } from '../../../source/js/utils.js'
import { assert, assertEqual } from '../testing.js'

const readSource = (relative: string) =>
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', relative), 'utf8')

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


describe('supabaseRaw — record mapping', () => {

  it('readRaw maps the row to a RawRecord', async () => {
      const { client } = fakeSupabaseClient({ row: { salt: 'salt-x', data: 'envelope', updated_at: '2024-06-01T00:00:00Z' } })
      const raw = supabaseRaw(client)
      const record = await raw.readRaw()
      assertEqual(record?.data, 'envelope', 'data')
      assertEqual(record?.salt, 'salt-x', 'salt')
      assertEqual(record?.updatedAt, '2024-06-01T00:00:00Z', 'updatedAt')
  })

  it('PGRST116 (row not found) reads as null, not an error', async () => {
      const { client } = fakeSupabaseClient({ tableError: { code: 'PGRST116', message: 'Row not found' } })
      const raw = supabaseRaw(client)
      assertEqual(await raw.readRaw(), null, 'readRaw null on not-found')
      assertEqual(await raw.head!(), null, 'head null on not-found')
      assertEqual(await raw.exists(), false, 'exists false on not-found')
  })

  it('a 401 maps to unauthenticated; transport failures map to network', async () => {
      const unauthorized = supabaseRaw(fakeSupabaseClient({ tableError: { status: 401, message: 'JWT invalid' } }).client)
      await expectStoreError(() => unauthorized.readRaw(), 'unauthenticated', '401')

      const offline = supabaseRaw(fakeSupabaseClient({ tableError: { message: 'TypeError: Failed to fetch' } }).client)
      await expectStoreError(() => offline.readRaw(), 'network', 'transport failure')
  })
})

describe('supabaseRaw — write path', () => {

  it('writeRaw sources the uid from the cached session, never auth.getUser()', async () => {
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

  it('writeRaw resolves with the token head() reports (self-push ping-pong guard)', async () => {
      const { client } = fakeSupabaseClient()
      const raw = supabaseRaw(client)
      const token = await raw.writeRaw({ data: 'envelope', salt: 'salt-x' })
      assertEqual(await raw.head!(), token, 'head equals the write token')
  })

  it('writeRaw without a signed-in session throws unauthenticated', async () => {
      const raw = supabaseRaw(fakeSupabaseClient({ sessionUser: null }).client)
      await expectStoreError(() => raw.writeRaw({ data: 'x' }), 'unauthenticated', 'no session')
  })

  it('clearRaw issues the RLS-scoped row delete', async () => {
      const { client } = fakeSupabaseClient({ row: { data: 'x', updated_at: 't' } })
      const raw = supabaseRaw(client)
      await raw.clearRaw()
      assert(client.calls.includes('delete:user_id=user-1'), 'delete eq user_id')
      assertEqual(await raw.readRaw(), null, 'row gone')
  })

  it('capabilities describe the backend honestly', () => {
      const caps = supabaseRaw(fakeSupabaseClient().client).capabilities
      assertEqual(caps.durable, 'always', 'server-side durability')
      assertEqual(caps.authenticated, true, 'requires sign-in')
      assertEqual(caps.encrypted, false, 'raw level is not encrypted')
      assertEqual(caps.changeDetection, true, 'head via updated_at')
  })

  // ─── AuthProvider ────────────────────────────────────────────────────────────
})

describe('supabaseAuth — contract', () => {

  it('signUp reports "confirmation required" as data, not a comment', async () => {
      const auth = supabaseAuth(fakeSupabaseClient({
          signUp: { user: { id: 'new-user', email: 'u@example.com', email_confirmed_at: null }, session: null }
      }).client)
      const result = await auth.signUp('u@example.com', 'password-123')
      assertEqual(result.session, false, 'no session when email confirmation is pending')
      assertEqual(result.user.emailVerified, false, 'email not confirmed')
  })

  it('signUp with an immediate session reports session: true', async () => {
      const auth = supabaseAuth(fakeSupabaseClient({
          signUp: { user: { id: 'new-user', email: 'u@example.com', email_confirmed_at: '2024-01-01' }, session: { token: 'x' } }
      }).client)
      const result = await auth.signUp('u@example.com', 'password-123')
      assertEqual(result.session, true, 'signed in immediately')
      assertEqual(result.user.emailVerified, true, 'email confirmed')
  })

  it('signIn maps to an AuthUser', async () => {
      const auth = supabaseAuth(fakeSupabaseClient().client)
      const user = await auth.signIn('u@example.com', 'password-123')
      assertEqual(user.id, 'user-1', 'user id')
      assertEqual(user.email, 'u@example.com', 'email')
      assertEqual(user.emailVerified, true, 'email verified')
  })

  it('getUser is the server-verified probe and returns null without a session', async () => {
      const auth = supabaseAuth(fakeSupabaseClient({ sessionUser: null }).client)
      assertEqual(await auth.getUser(), null, 'null user')
  })

  it('deleteUser is absent (presence is the capability)', () => {
      const auth = supabaseAuth(fakeSupabaseClient().client)
      assertEqual('deleteUser' in auth, false, 'deleteUser absent on Supabase (§4.5)')
      assertEqual('requestPasswordReset' in auth, true, 'password reset offered (resetPasswordForEmail)')
      assertEqual(auth.capabilities.passwordReset, true, 'passwordReset capability (resetPasswordForEmail)')
      assertEqual(auth.capabilities.oauth, false, 'oauth capability')
  })

  it('updatePassword and updateEmail go through updateUser', async () => {
      const { client } = fakeSupabaseClient()
      const auth = supabaseAuth(client)
      await auth.updatePassword('new-password-123')
      await auth.updateEmail('new@example.com')
      assert(client.calls.includes('auth:updateUser'), 'updateUser called')
  })

  it('requestPasswordReset sends the reset email back to the app origin', async () => {
      const { client, resetCalls } = fakeSupabaseClient()
      const auth = supabaseAuth(client)
      await auth.requestPasswordReset!('u@example.com')
      assert(client.calls.includes('auth:resetPasswordForEmail'), 'resetPasswordForEmail called')
      assertEqual(resetCalls.length, 1, 'one reset request')
      assertEqual(resetCalls[0].email, 'u@example.com', 'email passed through')
      assertEqual(resetCalls[0].redirectTo, window.location.origin, 'recovery link returns to the app')
  })

  it('requestPasswordReset maps a Supabase error', async () => {
      const { client } = fakeSupabaseClient({ resetError: { message: 'rate limit reached' } })
      const auth = supabaseAuth(client)
      await expectStoreError(() => auth.requestPasswordReset!('u@example.com'), 'network', 'reset error mapped')
  })
})

// ─── auth session storage (Rule 7, docs §4.5) ────────────────────────────────
//
// supabase-js persists the session, the user copy and the PKCE verifier under
// its own `sb-<ref>-*` keys. Rule 7 requires those to live behind a `store`
// slot so the device wipe can clear them deterministically.

describe('supabaseBackend — auth session storage', () => {

  it('builds the SDK client with the store-backed storage adapter', () => {
      let received: any = null
      const factory = (url: string, key: string, options: any) => {
          received = { url, key, options }
          return { fake: true }
      }
      store.supabaseSession.del()

      const client = createSupabaseClient(factory, 'https://demo.supabase.co', 'anon-key')

      assertEqual(client.fake, true, 'the factory result is returned')
      assertEqual(received.url, 'https://demo.supabase.co', 'url passed through')
      assert(received.options?.auth?.storage, 'createClient must receive auth.storage')
      assertEqual(typeof received.options.auth.storage.getItem, 'function', 'storage exposes getItem')
      assertEqual(received.options.realtime.enabled, false, 'realtime stays disabled')
  })

  it('keeps SDK keys in the session slot and never writes them to localStorage', () => {
      store.supabaseSession.del()
      const storage = supabaseAuthStorage()

      storage.setItem('sb-demo-auth-token', 'token-json')
      assertEqual(storage.getItem('sb-demo-auth-token'), 'token-json', 'round-trips through the slot')
      assertEqual(localStorage.getItem('sb-demo-auth-token'), null, 'no direct SDK localStorage key')
      assert(
          (store.supabaseSession.get() || '').includes('sb-demo-auth-token'),
          'the slot holds the SDK key/value map'
      )

      storage.removeItem('sb-demo-auth-token')
      assertEqual(storage.getItem('sb-demo-auth-token'), null, 'removeItem drops the entry')
      assertEqual(store.supabaseSession.get(null), null, 'an empty map removes the slot')
  })

  it('adopts and deletes a legacy sb-*-auth-token key written by an older build', () => {
      store.supabaseSession.del()
      localStorage.setItem('sb-legacyproj-auth-token', 'legacy-token-json')

      const storage = supabaseAuthStorage()
      createSupabaseClient(() => ({}), 'https://legacyproj.supabase.co', 'anon-key')

      assertEqual(storage.getItem('sb-legacyproj-auth-token'), 'legacy-token-json', 'legacy token adopted')
      assertEqual(localStorage.getItem('sb-legacyproj-auth-token'), null, 'legacy key removed')
  })

  it('ensureSupabaseClient builds through createSupabaseClient', () => {
      const src = readSource('source/js/supabaseBackend.ts')
      assert(
          /_client = createSupabaseClient\(factory, url, key\)/.test(src),
          'ensureSupabaseClient must not bypass the store-backed storage adapter'
      )
      assert(
          !/factory\(url, key, \{ realtime: \{ enabled: false \} \}/.test(src),
          'the client must not be constructed with bare options'
      )
  })
})