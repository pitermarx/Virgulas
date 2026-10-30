import { signal } from '@preact/signals'
import outline from './outline.js'
import { log, store } from './utils.js'
import { documentsEquivalent, merge, mergeDocuments } from './merge.js'
import type { NodeConflict } from './merge.js'
import { jsonCodec } from './docCodec.js'
import type { OutlineDoc, OutlineNode } from './docCodec.js'
import { HOSTED_BACKEND, parseBackendConfig, StoreError, type AuthProvider, type BackendConfig, type DocStore, type RawStore } from './storage.js'
import { ensureSupabaseClient, supabaseAuth, supabaseRaw } from './supabaseBackend.js'
import { sameOriginTrailbase, trailbaseAuth, trailbaseRaw } from './trailbaseBackend.js'

// Re-exported for the app/e2e seam and the unit suite: the merge algorithm
// itself lives in merge.ts (storage seam PR 1).
export { mergeDocuments }

// Type aliases kept for the existing import surface (app.ts, ui.ts, specs).
export type SyncNode = OutlineNode
export type SyncConflict = NodeConflict
export type MergedDoc = OutlineDoc

export interface RemoteSyncAttempt {
    epoch: number
    startedAt: number
}

export interface ConflictResolution {
    nodeId: string
    field: string
    chosenSide: 'local' | 'remote'
}

// ── Backend facade ───────────────────────────────────────────────────────────
//
// Client code lives in supabaseBackend.ts (docs/storage-interface.md §7): this
// module keeps only scheduling, polling, backoff and status/conflict signals.
// remoteSync is a thin auth/data facade over the backend adapters — no client
// construction, no error-code mapping, no row payloads.

/**
 * Resolves and builds the backend adapters. There is no user-facing backend
 * choice: the server is TrailBase on the origin serving the app, so the
 * resolution is —
 * 1. an explicit `backendconfig` override (dev/testing; no UI),
 * 2. a same-origin TrailBase probe (the app served by `trail run
 *    --public-dir dist` — self-hosted or hosted),
 * 3. the legacy `supabaseconfig` read-through (existing users keep their
 *    hosted Supabase data),
 * 4. the hosted Supabase fallback for static deployments without a server.
 * Resolution runs once per session and only inside the remote flows, so
 * startup never depends on a network round trip.
 */
let resolvedBackend: { raw: RawStore; auth: AuthProvider } | null = null
// A signal so the UI labels re-render when the remote flow resolves the server.
const resolvedKind = signal<'trailbase' | 'supabase'>('supabase')
let resolvedUrl = ''

export async function backend(): Promise<{ raw: RawStore; auth: AuthProvider }> {
    if (!resolvedBackend) {
        const override = store.backend.getOverride()
        const config: BackendConfig = override
            ? parseBackendConfig(override)
            : await sameOriginTrailbase()
                ? { backend: 'trailbase', url: '' }
                : store.supabase.get()
                    ? parseBackendConfig(store.supabase.get())
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

/**
 * Whether a Supabase client can be used at all. This is a build capability (the
 * chunk ships with the app and is fetched on demand), not a runtime check;
 * whether to *use* it is decided by the persisted mode in persistence.ts.
 */
export function hasSupabaseClient(): boolean {
    return true
}

// ── Sync status + conflict signals ───────────────────────────────────────────

export const syncStatus = signal<'synced' | 'syncing' | 'error' | 'offline'>('synced')
export const pendingConflicts = signal<SyncConflict[]>([])
export const pendingMergedDoc = signal<MergedDoc | null>(null)
export const pendingConflictResolutions = signal<Map<string, 'local' | 'remote'>>(new Map())

// Coordination flag: set to true before calling outline.deserialize from within
// sync/poll handlers so the persistence effect skips a redundant remote push.
export const skipNextRemotePush = signal(false)

// sync-01 (docs §4.4): a pull met a remote rotated on another device. The
// session locks and prompts for the new passphrase instead of the next local
// push silently reverting the rotation.
export const remoteRekeyed = signal(false)

const localWriteEpoch = signal(0)
const remoteSyncNotBefore = signal(0)
let remoteSyncQueue: Promise<any> = Promise.resolve()

// ── Remote store injection (docs §6.4) ───────────────────────────────────────
//
// The orchestration (persistence.ts constructs it, remoteSave.ts owns saves)
// injects the cached() composition here; every pull and push goes through the
// store, which owns the codec and the crypto. Secrets never transit this module.

let _remoteStore: DocStore | null = null

export function setRemoteStore(store: DocStore | null) {
    _remoteStore = store
}

function requireRemoteStore(): DocStore {
    if (!_remoteStore) throw new StoreError('unauthenticated', 'No remote session is active.')
    return _remoteStore
}

// ── Head-token helpers (docs §8) ─────────────────────────────────────────────
//
// The opaque head() change token lives in vmd_sync_head; the numeric merge
// baseline stays in vmd_sync_ts. Two clocks, two slots — the token is never
// parsed as a timestamp.

export function getLastSyncHead(): string | null {
    return store.syncHead.get(null)
}

export function setSyncHead(token: string | null) {
    if (token) store.syncHead.set(token)
    else store.syncHead.del()
}

export function noteLocalWriteActivity(now = Date.now()) {
    localWriteEpoch.value = localWriteEpoch.peek() + 1
    remoteSyncNotBefore.value = Math.max(
        remoteSyncNotBefore.peek(),
        now + outline.dirtyDebounceTimeout
    )
}

export function createRemoteSyncAttempt(): RemoteSyncAttempt {
    return { epoch: localWriteEpoch.peek(), startedAt: 0 }
}

export function canStartRemoteSync(now = Date.now()) {
    return now >= remoteSyncNotBefore.peek()
}

/**
 * Open the typing gate so the next push runs immediately. Teardown paths (lock,
 * sign-out) call this: the user has stopped typing and the session is about to
 * end, so a pending edit must be uploaded now rather than deferred past it.
 */
export function allowImmediateRemoteSync() {
    remoteSyncNotBefore.value = 0
}

/**
 * Milliseconds until a deferred remote push may run (0 when it can run now).
 * Used to reschedule a push that was skipped because the user is still typing,
 * instead of dropping it until the next unrelated save.
 */
export function remoteSyncRetryDelay(now = Date.now()) {
    return Math.max(0, remoteSyncNotBefore.peek() - now)
}

export function isRemoteSyncAttemptStale(attempt: RemoteSyncAttempt | null, now = Date.now()) {
    if (!attempt) return true
    return attempt.epoch !== localWriteEpoch.peek() || now < remoteSyncNotBefore.peek()
}

export function runExclusiveRemoteSync<T>(work: () => Promise<T>): Promise<T> {
    const run = remoteSyncQueue.then(work, work)
    remoteSyncQueue = run.catch(() => { })
    return run
}

// ── lastSyncedAt helpers (the merge baseline clock) ──────────────────────────

export function getLastSyncedAt() {
    return parseInt(store.syncTs.get('0') || '0') || 0
}

export function setLastSyncedAt(ts: number) {
    store.syncTs.set(String(ts))
}

// ── Typed-failure helper ─────────────────────────────────────────────────────

/**
 * Maps a failed sync step onto the status/notice surfaces. Returns true when
 * the failure was handled here (the caller must not proceed with a push —
 * in particular a remote-rekeyed pull is never followed by an upload).
 */
export function handleSyncFailure(error: unknown): boolean {
    if (error instanceof StoreError && error.code === 'remote-rekeyed') {
        // sync-01: never swallowed, never followed by a push.
        remoteRekeyed.value = true
        syncStatus.value = 'error'
        return true
    }
    log('[Sync] sync step failed:', error)
    syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
    return true
}

// ── Pull-before-push ─────────────────────────────────────────────────────────

export interface PullAndMergeResult {
    clean: boolean
    mergedJson: string | null
    /**
     * True when the merged document differs from the remote copy. When false,
     * the remote already holds this content: callers must apply the document
     * locally and adopt the observed head token without writing it back. A
     * write-back here would create a new revision, which makes every other
     * client pull again and write it back in turn.
     */
    needsPush: boolean
}

/**
 * Fetches the remote document through the store and merges it with the local
 * doc. Does NOT push and does NOT apply to the live outline. When clean,
 * mergedJson is the merged document JSON (or null if no remote document was
 * read); needsPush says whether that document differs from the remote copy.
 * When !clean, pendingConflicts and pendingMergedDoc are set.
 *
 * Decryption happens inside the store's session; a remote rotated on another
 * device surfaces as a remote-rekeyed StoreError — deliberately NOT swallowed
 * into a clean result (that was the sync-01 silent-overwrite bug).
 */
export async function pullAndMerge(): Promise<PullAndMergeResult> {
    const remote = requireRemoteStore()

    const remoteDoc = await remote.read()
    if (!remoteDoc) {
        return { clean: true, mergedJson: null, needsPush: true }
    }

    const localDoc = jsonCodec.parse(outline.serialize())
    const lastSyncedAt = getLastSyncedAt()
    const result = merge(localDoc, remoteDoc, lastSyncedAt)

    if (result.kind === 'conflict') {
        pendingConflicts.value = result.conflicts
        pendingMergedDoc.value = result.partial
        pendingConflictResolutions.value = new Map()
        return { clean: false, mergedJson: null, needsPush: false }
    }

    return {
        clean: true,
        mergedJson: jsonCodec.serialize(result.doc),
        needsPush: !documentsEquivalent(result.doc, remoteDoc)
    }
}

/**
 * Apply conflict resolutions, push merged doc, and clear conflict state.
 * @param {Array<{ nodeId: string, field: string, chosenSide: 'local' | 'remote' }>} resolutions
 */
export async function resolveConflicts(resolutions: ConflictResolution[]) {
    const doc = pendingMergedDoc.peek()
    if (!doc) return

    const remote = requireRemoteStore()

    // Build a map of chosen values per nodeId::field
    const choiceMap = new Map<string, 'local' | 'remote'>()
    for (const res of resolutions) {
        choiceMap.set(`${res.nodeId}::${res.field}`, res.chosenSide)
    }

    // Conflict values for lookup
    const conflictValues = new Map()
    for (const c of pendingConflicts.peek()) {
        conflictValues.set(`${c.nodeId}::${c.field}`, { local: c.localValue, remote: c.remoteValue })
    }

    // Apply chosen values to the merged nodes
    const updatedNodes = doc.nodes.map(node => {
        let updated = { ...node }
        for (const field of ['text', 'description', 'children']) {
            const key = `${node.id}::${field}`
            const side = choiceMap.get(key)
            if (side) {
                const vals = conflictValues.get(key)
                if (vals) updated[field] = vals[side]
            }
        }
        return updated
    })

    const mergedObj: OutlineDoc = { ...doc, nodes: updatedNodes }

    try {
        syncStatus.value = 'syncing'
        const token = await remote.write(mergedObj)
        if (token) setSyncHead(token)
        setLastSyncedAt(Date.now())
        syncStatus.value = 'synced'
    } catch (err) {
        log('[Sync] resolveConflicts push failed:', err)
        handleSyncFailure(err)
    }

    // Apply merged doc locally; set flag so persistence effect skips the re-push
    skipNextRemotePush.value = true
    outline.deserialize(jsonCodec.serialize(mergedObj))

    pendingConflicts.value = []
    pendingMergedDoc.value = null
    pendingConflictResolutions.value = new Map()
}

// ── Background polling ────────────────────────────────────────────────────────

let _pollingInterval: ReturnType<typeof setInterval> | null = null

export function startPolling() {
    stopPolling()
    const pollIntervalMs = typeof window !== 'undefined' && window.__syncPollIntervalMs
        ? window.__syncPollIntervalMs
        : 60_000
    _pollingInterval = setInterval(() => {
        const attempt = createRemoteSyncAttempt()
        // Don't stack pulls while conflicts are pending
        if (pendingConflicts.peek().length > 0) return

        if (!canStartRemoteSync() || isRemoteSyncAttemptStale(attempt)) return

        void runExclusiveRemoteSync(async () => {
            if (pendingConflicts.peek().length > 0) return
            if (!canStartRemoteSync() || isRemoteSyncAttemptStale(attempt)) return

            try {
                const remote = requireRemoteStore()

                // Change detection is the opaque head token, compared for
                // inequality only. head() errors are treated as "no change".
                let token: string | null = null
                try {
                    token = await remote.head?.() ?? null
                } catch {
                    return
                }
                if (!token || token === getLastSyncHead()) return
                if (isRemoteSyncAttemptStale(attempt)) return

                log('[Sync] Polling detected remote update, pulling...')

                syncStatus.value = 'syncing'
                const result = await pullAndMerge()
                if (isRemoteSyncAttemptStale(attempt)) return

                if (!result.clean) {
                    syncStatus.value = 'synced'
                    return
                }

                if (result.mergedJson) {
                    if (result.needsPush) {
                        const mergedDoc = jsonCodec.parse(result.mergedJson)
                        // Push the merged doc; write() resolves with the new head
                        // token, which the poller adopts so it never re-pulls its
                        // own update.
                        const newToken = await remote.write(mergedDoc)
                        if (isRemoteSyncAttemptStale(attempt)) return
                        if (newToken) setSyncHead(newToken)
                    } else {
                        if (isRemoteSyncAttemptStale(attempt)) return
                        // The remote already has this content. Adopt the token
                        // we just observed instead of writing an identical
                        // document, which would only make other clients pull.
                        setSyncHead(token)
                    }
                    setLastSyncedAt(Date.now())
                    // Apply locally; flag prevents persistence effect re-push
                    skipNextRemotePush.value = true
                    outline.deserialize(result.mergedJson)
                }

                syncStatus.value = 'synced'
            } catch (err) {
                if (isRemoteSyncAttemptStale(attempt)) return
                log('[Sync] Poll pull failed:', err)
                handleSyncFailure(err)
            }
        })
    }, pollIntervalMs)
}

export function stopPolling() {
    if (_pollingInterval !== null) {
        clearInterval(_pollingInterval)
        _pollingInterval = null
    }
}
