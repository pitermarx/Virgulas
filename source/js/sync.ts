// Remote sync scheduling: which backend the deployment talks to, the auth
// facade the UI calls, and the background poll.
//
// The pull-before-push step itself lives in syncEngine.ts; the save debounce
// and the deferred push live in remoteSave.ts. This module only decides *when*
// to run a step and over which backend.

import { signal } from '@preact/signals'
import { store } from './utils.js'
import { HOSTED_BACKEND, parseBackendConfig, StoreError, type AuthProvider, type BackendConfig, type RawStore } from './storage.js'
import { ensureSupabaseClient, supabaseAuth, supabaseRaw } from './supabaseBackend.js'
import { sameOriginTrailbase, trailbaseAuth, trailbaseRaw } from './trailbaseBackend.js'
import { createRemoteSyncAttempt, syncOnce } from './syncEngine.js'

// ── Backend facade ───────────────────────────────────────────────────────────
//
// Client code lives in supabaseBackend.ts (docs/storage-interface.md §3): this
// module keeps only backend resolution, scheduling and the auth facade.
// `remoteSync` is a thin proxy over the backend adapters — no client
// construction, no error-code mapping, no row payloads.

/**
 * Resolves and builds the backend adapters. There is no user-facing backend
 * choice: the server is TrailBase on the origin serving the app, so the
 * resolution is —
 * 1. an explicit `backendconfig` override (dev/testing; no UI),
 * 2. a same-origin TrailBase probe (the app served by `trail run
 *    --public-dir dist` — self-hosted or hosted),
 * 3. the hosted Supabase fallback for static deployments without a server.
 * Resolution runs once per session and only inside the remote flows, so
 * startup never depends on a network round trip.
 */
let resolvedBackend: { raw: RawStore; auth: AuthProvider } | null = null
// A signal so the UI labels re-render when the remote flow resolves the server.
const resolvedKind = signal<'trailbase' | 'supabase'>('supabase')
let resolvedUrl = ''

export async function backend(): Promise<{ raw: RawStore; auth: AuthProvider }> {
    if (!resolvedBackend) {
        const override = store.backend.get()
        const config: BackendConfig = override
            ? parseBackendConfig(override)
            : await sameOriginTrailbase()
                ? { backend: 'trailbase', url: '' }
                : { ...HOSTED_BACKEND }
        resolvedKind.value = config.backend === 'trailbase' ? 'trailbase' : 'supabase'
        resolvedUrl = config.url || ''
        if (config.backend === 'trailbase') {
            resolvedBackend = { raw: trailbaseRaw(config), auth: trailbaseAuth(config) }
        } else {
            const client = await ensureSupabaseClient(config)
            resolvedBackend = { raw: supabaseRaw(client), auth: supabaseAuth(client) }
        }
        remoteResetAvailable.value = !!resolvedBackend.auth.requestPasswordReset
    }
    return resolvedBackend
}

/** Whether the resolved backend can send password reset emails — gates the
 * lock screen's "Forgot password?" affordance (capability, §4.5). */
export const remoteResetAvailable = signal(false)

/** The resolved backend's kind — UI branching (sign-up messaging, labels).
 * 'supabase' until the first remote flow resolves the real backend. */
export function backendKind(): 'trailbase' | 'supabase' {
    return resolvedKind.value
}

/** The resolved backend's base URL: '' when same-origin (the default). */
export function backendUrl(): string {
    return resolvedUrl
}

export const remoteSync = {
    signIn: async (email: string, password: string) => (await backend()).auth.signIn(email, password),
    signUp: async (email: string, password: string) => (await backend()).auth.signUp(email, password),
    signOut: async () => (await backend()).auth.signOut(),
    getUser: async () => (await backend()).auth.getUser(),
    updatePassword: async (newPassword: string) => (await backend()).auth.updatePassword(newPassword),
    updateEmail: async (newEmail: string) => (await backend()).auth.updateEmail(newEmail),
    /** Self-service password reset email — only on backends that support it
     * (both built-ins do; the capability keeps custom adapters honest). */
    requestPasswordReset: async (email: string) => {
        const auth = (await backend()).auth
        if (!auth.requestPasswordReset) throw new StoreError('unsupported', 'This backend cannot send password reset emails.')
        await auth.requestPasswordReset(email)
    },
    /** True when the configured backend can send password reset emails. */
    hasPasswordReset: async () => !!(await backend()).auth.requestPasswordReset,
    /**
     * Self-service auth-account deletion — present only on backends that
     * support it (TrailBase does; Supabase needs the service role, which the
     * browser never holds). The account-deletion flow branches on this.
     */
    deleteUser: async () => {
        const auth = (await backend()).auth
        if (!auth.deleteUser) throw new StoreError('unsupported', 'This backend cannot delete the auth account.')
        await auth.deleteUser()
    },
    /** True when the configured backend can delete the auth account. */
    hasDeleteUser: async () => !!(await backend()).auth.deleteUser,
    /** Deletes the signed-in user's own document row (ACL/RLS-scoped). The
     * auth account itself is only removed when deleteUser is present. */
    deleteOutline: async () => {
        await (await backend()).raw.clearRaw()
    },
    /**
     * Raw row probe for boot: no decryption, no passphrase — only ever runs
     * for a persisted Remote mode (the startup-path rule keeps it off everyone
     * else's boot).
     */
    readRow: async () => (await backend()).raw.readRaw(),

    /** Eager backend resolution — the wizard's cloud path calls this so the
     * credentials form names the resolved server as soon as it renders. */
    resolveBackend: async () => backend()
}

// ── Background polling (docs §6.4) ───────────────────────────────────────────

let _pollingInterval: ReturnType<typeof setInterval> | null = null

/**
 * Background poll interval. `window.__syncPollIntervalMs` is a Playwright seam:
 * it is read only in the test bundle (struct-06), so a same-origin script
 * cannot make the poll hammer the server in production.
 */
export function resolvePollIntervalMs(): number {
    if (typeof __TEST_HOOKS__ !== 'undefined' && __TEST_HOOKS__ && typeof window !== 'undefined') {
        const override = window.__syncPollIntervalMs
        if (typeof override === 'number' && Number.isFinite(override) && override >= 1) return override
    }
    return 60_000
}

/** The poll only decides when to look; `syncOnce` decides what a look means
 * (unchanged head, a merge, a pending conflict, or still typing). */
export function startPolling() {
    stopPolling()
    _pollingInterval = setInterval(() => {
        void syncOnce({ attempt: createRemoteSyncAttempt() })
    }, resolvePollIntervalMs())
}

export function stopPolling() {
    if (_pollingInterval !== null) {
        clearInterval(_pollingInterval)
        _pollingInterval = null
    }
}
