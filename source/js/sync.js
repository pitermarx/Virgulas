import { signal } from '@preact/signals'
import { encrypt, decrypt } from './crypto2.js'
import outline from './outline.js'
import { log, store } from './utils.js'
import { devSync } from './devtools.js'

// ── Supabase remote sync client ──────────────────────────────────────────────

const DEFAULT_CONFIG = { url: 'https://gcpdascpdrakecpknrtt.supabase.co', key: 'sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc' }
let _client = null
let _mainTable = null

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

function ensureClient() {
    if (!window.supabase?.createClient) {
        throw new Error('Supabase client is unavailable in this environment')
    }
    if (_client) return _client
    const config = readConfig()
    _client = window.supabase.createClient(config.url, config.key, { realtime: { enabled: false } })
    _mainTable = _client.from('outlines')
    return _client
}

async function withClient(fn) {
    const active = ensureClient()
    const { data, error } = await fn(active)
    if (error && error.code !== 'PGRST116') throw error
    return data
}

export const remoteSync = {
    withClient,
    signIn: (email, password) => withClient((c) => c.auth.signInWithPassword({ email, password })),
    signUp: (email, password) => withClient((c) => c.auth.signUp({ email, password })),
    signOut: async () => {
        const c = ensureClient()
        return c.auth.signOut()
    },
    getUser: () => withClient((c) => c.auth.getUser()).then(res => res?.user ?? null),
    read: () => withClient(() => _mainTable.select('salt, data, updated_at').single()),
    getLastUpdate: () => withClient(() => _mainTable.select('updated_at').single()),
    upsert: async (data, salt, updatedAt = new Date().toISOString()) => {
        const user = await remoteSync.getUser()
        const payload = {
            data,
            updated_at: updatedAt,
            user_id: user?.id
        }
        if (salt) payload.salt = salt
        return withClient(() => _mainTable.upsert(payload, { onConflict: 'user_id' }))
    }
}

// ── Sync status + conflict signals ───────────────────────────────────────────

export const syncStatus = signal('synced') // 'synced' | 'syncing' | 'error' | 'offline'
export const pendingConflicts = signal([])  // [{ nodeId, nodeText, field, localValue, remoteValue }]
export const pendingMergedDoc = signal(null) // merged node array awaiting conflict resolution
export const pendingConflictResolutions = signal(new Map()) // Map of `nodeId::field` -> 'local' | 'remote'

// Coordination flag: set to true before calling outline.deserialize from within
// sync/poll handlers so the persistence effect skips a redundant remote push.
export const skipNextRemotePush = signal(false)

const localWriteEpoch = signal(0)
const remoteSyncNotBefore = signal(0)
let remoteSyncQueue = Promise.resolve()
let lastCompletedRemotePush = { epoch: -1, updatedAt: 0 }

// Internal stored credentials (set during remote unlock, cleared on sign-out)
let _passphrase = ''
let _salt = ''

export function setCredentials(passphrase, salt) {
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

export function createRemoteSyncAttempt() {
    return { epoch: localWriteEpoch.peek(), startedAt: 0 }
}

export function canStartRemoteSync(now = Date.now()) {
    return now >= remoteSyncNotBefore.peek()
}

export function isRemoteSyncAttemptStale(attempt, now = Date.now()) {
    if (!attempt) return true
    return attempt.epoch !== localWriteEpoch.peek() || now < remoteSyncNotBefore.peek()
}

export function beginRemotePush(attempt, startedAt = Date.now()) {
    if (attempt) {
        attempt.startedAt = startedAt
    }
    return new Date(startedAt).toISOString()
}

export function recordCompletedRemotePush(attempt) {
    if (!attempt?.startedAt) return
    lastCompletedRemotePush = {
        epoch: attempt.epoch,
        updatedAt: attempt.startedAt
    }
}

export function runExclusiveRemoteSync(work) {
    const run = remoteSyncQueue.then(work, work)
    remoteSyncQueue = run.catch(() => { })
    return run
}

function isSupersededOwnRemoteUpdate(remoteTs) {
    return remoteTs > 0
        && remoteTs <= lastCompletedRemotePush.updatedAt
        && lastCompletedRemotePush.epoch < localWriteEpoch.peek()
}

// ── Merge algorithm ──────────────────────────────────────────────────────────

/**
 * Merges two node arrays (local + remote) using per-node lastModified timestamps.
 *
 * @param {object[]} localNodes  - nodes from outline.serialize()
 * @param {object[]} remoteNodes - nodes decrypted from remote
 * @param {number}   lastSyncedAt - epoch ms of last successful sync (0 = never)
 * @returns {{ merged: object[], conflicts: object[] }}
 */
export function mergeDocuments(localNodes, remoteNodes, lastSyncedAt) {
    const localMap = new Map(localNodes.map(n => [n.id, n]))
    const remoteMap = new Map(remoteNodes.map(n => [n.id, n]))

    const merged = []
    const conflicts = []

    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()])

    for (const id of allIds) {
        const local = localMap.get(id)
        const remote = remoteMap.get(id)

        const localMod = local?.lastModified || 0
        const remoteMod = remote?.lastModified || 0
        const localChanged = localMod > lastSyncedAt
        const remoteChanged = remoteMod > lastSyncedAt

        // Root node is never deleted regardless of timestamps
        if (id === 'root') {
            merged.push(local || remote)
            continue
        }

        if (local && !remote) {
            // Only in local
            if (localChanged) merged.push(local)      // added locally → keep
            // else: deleted remotely → omit
            continue
        }

        if (!local && remote) {
            // Only in remote
            if (remoteChanged) merged.push(remote)    // added remotely → keep
            // else: deleted locally → omit
            continue
        }

        // Both exist
        if (localChanged && !remoteChanged) {
            merged.push(local)
        } else if (!localChanged && remoteChanged) {
            merged.push(remote)
        } else if (!localChanged && !remoteChanged) {
            merged.push(local)
        } else {
            // Both modified → per-field comparison
            const mergedNode = { ...local }

            // open: last-writer-wins, never a conflict
            mergedNode.open = localMod >= remoteMod ? local.open : remote.open
            mergedNode.lastModified = Math.max(localMod, remoteMod)

            // text
            if ((local.text || '') !== (remote.text || '')) {
                conflicts.push({
                    nodeId: id,
                    nodeText: local.text || remote.text || '',
                    field: 'text',
                    localValue: local.text || '',
                    remoteValue: remote.text || ''
                })
            }

            // description
            if ((local.description || '') !== (remote.description || '')) {
                conflicts.push({
                    nodeId: id,
                    nodeText: local.text || remote.text || '',
                    field: 'description',
                    localValue: local.description || '',
                    remoteValue: remote.description || ''
                })
            }

            // children (compare as JSON string)
            const localChildren = JSON.stringify(local.children || [])
            const remoteChildren = JSON.stringify(remote.children || [])
            if (localChildren !== remoteChildren) {
                conflicts.push({
                    nodeId: id,
                    nodeText: local.text || remote.text || '',
                    field: 'children',
                    localValue: local.children || [],
                    remoteValue: remote.children || []
                })
            }

            merged.push(mergedNode)
        }
    }

    // Validate tree integrity: drop nodes whose parent is not present
    const mergedIds = new Set(merged.map(n => n.id))
    const valid = merged.filter(n => {
        if (n.id === 'root') return true
        if (!mergedIds.has(n.parentId)) {
            log(`[Sync] Node ${n.id} has missing parent ${n.parentId}, dropping from merge`)
            return false
        }
        return true
    })

    return { merged: valid, conflicts }
}

// ── lastSyncedAt helpers ─────────────────────────────────────────────────────

export function getLastSyncedAt() {
    return parseInt(store.syncTs.get('0') || '0') || 0
}

export function setLastSyncedAt(ts) {
    store.syncTs.set(String(ts))
    devSync.lastSyncAt.value = ts
}

// ── Pull-before-push ─────────────────────────────────────────────────────────

/**
 * Checks if the remote document is newer than our last sync.
 * @returns {Promise<boolean>}
 */
export async function checkRemoteNewer(lastSyncedAt) {
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
export async function pullAndMerge(passphrase, salt) {
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
    const { merged, conflicts } = mergeDocuments(
        localObj.nodes,
        remoteObj.nodes,
        lastSyncedAt
    )

    if (conflicts.length > 0) {
        pendingConflicts.value = conflicts
        pendingMergedDoc.value = { ...localObj, nodes: merged }
        pendingConflictResolutions.value = new Map()
        devSync.conflictCount.value = devSync.conflictCount.peek() + conflicts.length
        return { clean: false, mergedJson: null }
    }

    const mergedObj = { ...localObj, nodes: merged }
    return { clean: true, mergedJson: JSON.stringify(mergedObj) }
}

/**
 * Apply conflict resolutions, push merged doc, and clear conflict state.
 * @param {Array<{ nodeId: string, field: string, chosenSide: 'local' | 'remote' }>} resolutions
 */
export async function resolveConflicts(resolutions) {
    const doc = pendingMergedDoc.peek()
    if (!doc) return

    const passphrase = _passphrase
    const salt = _salt

    if (!passphrase || !salt) {
        log('[Sync] resolveConflicts: missing credentials')
        return
    }

    // Build a map of chosen values per nodeId::field
    const choiceMap = new Map()
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

let _pollingInterval = null

export function startPolling() {
    stopPolling()
    const pollIntervalMs = typeof window !== 'undefined' && window.__syncPollIntervalMs
        ? window.__syncPollIntervalMs
        : 60_000
    _pollingInterval = setInterval(() => {
        const attempt = createRemoteSyncAttempt()
        devSync.pollRunCount.value = devSync.pollRunCount.peek() + 1
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
