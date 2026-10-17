import { signal } from '@preact/signals'
import { encrypt, decrypt } from './crypto2.js'
import outline from './outline.js'
import { log, store } from './utils.js'
import { merge } from './merge.js'
import type { NodeConflict } from './merge.js'
import type { OutlineDoc, OutlineNode } from './docCodec.js'

// Re-exported for the app/e2e seam and the unit suite: the merge algorithm
// itself now lives in merge.ts (storage seam PR 1).
export { mergeDocuments } from './merge.js'

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

// ── Supabase remote sync client ──────────────────────────────────────────────

const DEFAULT_CONFIG = { url: 'https://gcpdascpdrakecpknrtt.supabase.co', key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc' }
let _client: any = null
let _mainTable: any = null

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

// Supabase is ~220KB minified and is only needed by users who actually chose
// remote mode. It is loaded through a dynamic import so the bundler emits it as
// a separate chunk: local/memory/file users never download or parse it, and
// remote users fetch it off the critical startup path.
type ClientFactory = (url: string, key: string, options?: any) => any

let _clientFactory: ClientFactory | null = null

async function loadClientFactory(): Promise<ClientFactory> {
    if (_clientFactory) return _clientFactory

    // Test seam. `__TEST_HOOKS__` is a build-time constant: `true` only in the
    // Playwright bundle (`bun run dev:test`), `false` in production, where this
    // branch is dropped entirely. Without the gate, any same-origin script could
    // substitute the Supabase client and capture sign-in credentials or the
    // session token.
    if (typeof __TEST_HOOKS__ !== 'undefined' && __TEST_HOOKS__ && typeof window.supabase?.createClient === 'function') {
        _clientFactory = window.supabase.createClient as ClientFactory
        return _clientFactory
    }

    const { createClient } = await import('@supabase/supabase-js')
    _clientFactory = createClient as ClientFactory
    return _clientFactory
}

async function ensureClient() {
    if (_client) return _client
    const factory = await loadClientFactory()
    const config = readConfig()
    _client = factory(config.url, config.key, { realtime: { enabled: false } } as any)
    _mainTable = _client.from('outlines')
    return _client
}

/**
 * Whether a Supabase client can be used at all. This is a build capability (the
 * chunk ships with the app and is fetched on demand), not a runtime check;
 * whether to *use* it is decided by the persisted mode in persistence.ts.
 */
export function hasSupabaseClient(): boolean {
    return true
}

async function withClient<T = any>(fn: (client: any) => Promise<{ data: T; error: any }>): Promise<T> {
    const active = await ensureClient()
    const { data, error } = await fn(active)
    if (error && error.code !== 'PGRST116') throw error
    return data
}

export const remoteSync = {
    withClient,
    signIn: (email: string, password: string) => withClient((c) => c.auth.signInWithPassword({ email, password })),
    /**
     * Creates an account. Supabase returns `{ user, session }`; when the project
     * requires email confirmation, `session` is null and no session exists until
     * the user confirms. Callers must treat that as "confirmation required"
     * rather than "signed in".
     */
    signUp: (email: string, password: string) => withClient((c) => c.auth.signUp({ email, password })),
    signOut: async () => {
        const c = await ensureClient()
        return c.auth.signOut()
    },
    getUser: () => withClient((c) => c.auth.getUser()).then(res => res?.user ?? null),
    read: () => withClient(() => _mainTable.select('salt, data, updated_at').single()),
    getLastUpdate: () => withClient(() => _mainTable.select('updated_at').single()),
    upsert: async (data: string, salt: string | null, updatedAt = new Date().toISOString()) => {
        const user = await remoteSync.getUser()
        const payload: Record<string, any> = {
            data,
            updated_at: updatedAt,
            user_id: user?.id
        }
        if (salt) payload.salt = salt
        return withClient(() => _mainTable.upsert(payload, { onConflict: 'user_id' }))
    },
    updatePassword: (newPassword: string) => withClient((c) => c.auth.updateUser({ password: newPassword })),
    updateEmail: (newEmail: string) => withClient((c) => c.auth.updateUser({ email: newEmail })),
    /**
     * Deletes the signed-in user's own `outlines` row (RLS-scoped DELETE policy).
     * This removes the encrypted document from the server. It cannot remove the
     * `auth.users` record — that needs the service role and is out of reach of
     * the browser client.
     */
    deleteOutline: async () => {
        const user = await remoteSync.getUser()
        if (!user?.id) throw new Error('Not signed in. Sign in again before deleting your account.')
        return withClient(() => _mainTable.delete().eq('user_id', user.id))
    }
}

// ── Sync status + conflict signals ───────────────────────────────────────────

export const syncStatus = signal<'synced' | 'syncing' | 'error' | 'offline'>('synced')
export const pendingConflicts = signal<SyncConflict[]>([])
export const pendingMergedDoc = signal<MergedDoc | null>(null)
export const pendingConflictResolutions = signal<Map<string, 'local' | 'remote'>>(new Map())

// Coordination flag: set to true before calling outline.deserialize from within
// sync/poll handlers so the persistence effect skips a redundant remote push.
export const skipNextRemotePush = signal(false)

const localWriteEpoch = signal(0)
const remoteSyncNotBefore = signal(0)
let remoteSyncQueue: Promise<any> = Promise.resolve()
let lastCompletedRemotePush = { epoch: -1, updatedAt: 0 }

// Internal stored credentials (set during remote unlock, cleared on sign-out)
let _passphrase = ''
let _salt = ''

export function setCredentials(passphrase: string, salt: string) {
    _passphrase = passphrase
    _salt = salt
}

export function clearCredentials() {
    _passphrase = ''
    _salt = ''
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

export function beginRemotePush(attempt: RemoteSyncAttempt | null, startedAt = Date.now()) {
    if (attempt) {
        attempt.startedAt = startedAt
    }
    return new Date(startedAt).toISOString()
}

export function recordCompletedRemotePush(attempt: RemoteSyncAttempt | null) {
    if (!attempt?.startedAt) return
    lastCompletedRemotePush = {
        epoch: attempt.epoch,
        updatedAt: attempt.startedAt
    }
}

export function runExclusiveRemoteSync<T>(work: () => Promise<T>): Promise<T> {
    const run = remoteSyncQueue.then(work, work)
    remoteSyncQueue = run.catch(() => { })
    return run
}

function isSupersededOwnRemoteUpdate(remoteTs: number) {
    return remoteTs > 0
        && remoteTs <= lastCompletedRemotePush.updatedAt
        && lastCompletedRemotePush.epoch < localWriteEpoch.peek()
}

// ── lastSyncedAt helpers ─────────────────────────────────────────────────────

export function getLastSyncedAt() {
    return parseInt(store.syncTs.get('0') || '0') || 0
}

export function setLastSyncedAt(ts: number) {
    store.syncTs.set(String(ts))
}

// ── Pull-before-push ─────────────────────────────────────────────────────────

/**
 * Checks if the remote document is newer than our last sync.
 * @returns {Promise<boolean>}
 */
export async function checkRemoteNewer(lastSyncedAt: number) {
    try {
        const remote = await remoteSync.getLastUpdate()
        if (!remote?.updated_at) return false
        const remoteTs = new Date(remote.updated_at).getTime()
        if (isSupersededOwnRemoteUpdate(remoteTs)) return false
        return remoteTs > lastSyncedAt
    } catch {
        return false
    }
}

/**
 * Fetches remote data and merges with local doc.
 * Does NOT push and does NOT apply to the live outline.
 * Returns { clean: true, mergedJson: string | null } or { clean: false, mergedJson: null }.
 * When clean, mergedJson is the merged document JSON (or null if no merge was needed).
 * When !clean, pendingConflicts and pendingMergedDoc are set.
 *
 * @param {string} passphrase
 * @param {string} salt
 */
export async function pullAndMerge(passphrase: string, salt: string) {
    const remoteData = await remoteSync.read()
    if (!remoteData?.data) {
        return { clean: true, mergedJson: null }
    }

    const remoteSalt = remoteData.salt || salt
    let remoteJson
    try {
        remoteJson = await decrypt(remoteData.data, passphrase, remoteSalt)
    } catch (err) {
        log('[Sync] Failed to decrypt remote data during pull-merge:', err)
        return { clean: true, mergedJson: null } // can't merge, proceed with local
    }

    const remoteObj = JSON.parse(remoteJson)
    const localJson = outline.serialize()
    const localObj = JSON.parse(localJson)

    const lastSyncedAt = getLastSyncedAt()
    const result = merge(localObj, remoteObj, lastSyncedAt)

    if (result.kind === 'conflict') {
        pendingConflicts.value = result.conflicts
        pendingMergedDoc.value = result.partial
        pendingConflictResolutions.value = new Map()
        return { clean: false, mergedJson: null }
    }

    return { clean: true, mergedJson: JSON.stringify(result.doc) }
}

/**
 * Apply conflict resolutions, push merged doc, and clear conflict state.
 * @param {Array<{ nodeId: string, field: string, chosenSide: 'local' | 'remote' }>} resolutions
 */
export async function resolveConflicts(resolutions: ConflictResolution[]) {
    const doc = pendingMergedDoc.peek()
    if (!doc) return

    const passphrase = _passphrase
    const salt = _salt

    if (!passphrase || !salt) {
        log('[Sync] resolveConflicts: missing credentials')
        return
    }

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

    const mergedObj = { ...doc, nodes: updatedNodes }
    const mergedJson = JSON.stringify(mergedObj)

    try {
        syncStatus.value = 'syncing'
        const encrypted = await encrypt(mergedJson, passphrase, salt)
        await remoteSync.upsert(encrypted, salt)
        setLastSyncedAt(Date.now())
        syncStatus.value = 'synced'
    } catch (err) {
        log('[Sync] resolveConflicts push failed:', err)
        syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
    }

    // Apply merged doc locally; set flag so persistence effect skips the re-push
    skipNextRemotePush.value = true
    outline.deserialize(mergedJson)

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

            const lastSyncedAt = getLastSyncedAt()
            let isNewer = false
            try {
                isNewer = await checkRemoteNewer(lastSyncedAt)
            } catch {
                return
            }

            if (!isNewer || isRemoteSyncAttemptStale(attempt)) return

            log('[Sync] Polling detected remote update, pulling...')
            const passphrase = _passphrase
            const salt = _salt
            if (!passphrase || !salt) return

            try {
                syncStatus.value = 'syncing'
                const result = await pullAndMerge(passphrase, salt)
                if (isRemoteSyncAttemptStale(attempt)) return

                if (!result.clean) {
                    syncStatus.value = 'synced'
                    return
                }

                if (result.mergedJson) {
                    const encrypted = await encrypt(result.mergedJson, passphrase, salt)
                    if (isRemoteSyncAttemptStale(attempt)) return
                    const updatedAt = beginRemotePush(attempt)
                    await remoteSync.upsert(encrypted, salt, updatedAt)
                    recordCompletedRemotePush(attempt)
                    if (isRemoteSyncAttemptStale(attempt)) return
                    setLastSyncedAt(Date.now())
                    // Apply locally; flag prevents persistence effect re-push
                    skipNextRemotePush.value = true
                    outline.deserialize(result.mergedJson)
                }

                syncStatus.value = 'synced'
            } catch (err) {
                if (isRemoteSyncAttemptStale(attempt)) return
                log('[Sync] Poll pull failed:', err)
                syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
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
