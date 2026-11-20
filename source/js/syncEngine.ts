// The remote sync engine (docs §4.4, §6.4).
//
// There is exactly one pull-before-push step here. The autosave and the
// background poll call `syncOnce` and only decide *when* to sync; the
// head-token check, the pull/merge, the retry policy, the clock updates and the
// conflict hand-off live here and nowhere else.
//
// Local durability is not this module's job: persistence writes the document to
// the durable local copy on every save, so a step skipped while the user types
// never risks the document, and the next save retries the network side.
//
// Everything crossing this boundary is a document or a typed outcome: no
// ciphertext, no keys and no backend specifics. The composed Remote DocStore
// (codec over cached-over-encrypted) is injected, so pulls and pushes go
// through the store that owns the crypto.

import { signal } from '@preact/signals'
import outline from './outline.js'
import { log, store } from './utils.js'
import { CONFLICT_FIELDS, attachMissingChildren, documentsEquivalent, merge } from './merge.js'
import type { NodeConflict } from './merge.js'
import { jsonCodec } from './docCodec.js'
import type { OutlineDoc, OutlineNode } from './model.js'
import { StoreError, type DocStore } from './storage.js'

export interface RemoteSyncAttempt {
    epoch: number
}

export interface ConflictResolution {
    nodeId: string
    field: string
    chosenSide: 'local' | 'remote'
}

/** Why a sync step did nothing. */
export type SyncSkipReason =
    /** The user is still typing; the caller should retry once the debounce ends. */
    | 'typing'
    /** A newer local write superseded the step while it ran. */
    | 'stale'
    /** No Remote session is active. */
    | 'no-remote'

/** What one sync step did. Callers schedule; they never interpret the store. */
export type SyncOutcome =
    | { kind: 'pushed' }
    | { kind: 'merged'; pushed: boolean }
    | { kind: 'unchanged' }
    | { kind: 'conflict' }
    | { kind: 'skipped'; reason: SyncSkipReason }
    | { kind: 'failed'; error: unknown }

export interface SyncStep {
    /** The document this step may upload. Omitted by the poll, which only pulls. */
    doc?: OutlineDoc
    /** The write epoch the step belongs to. A newer local write supersedes it,
     * so a save never uploads a document the user has already moved past. */
    attempt: RemoteSyncAttempt
}

// ── Status and conflict signals ──────────────────────────────────────────────

export const syncStatus = signal<'synced' | 'syncing' | 'error' | 'offline' | 'too-large'>('synced')
export const pendingConflicts = signal<NodeConflict[]>([])
export const pendingMergedDoc = signal<OutlineDoc | null>(null)
export const pendingConflictResolutions = signal<Map<string, 'local' | 'remote'>>(new Map())

/** Set when a merge has just been applied locally: the save that applying it
 * triggers must persist the document but not upload it a second time.
 * `persistence.ts` owns the save edge and consumes it. */
export const skipNextRemotePush = signal(false)

// sync-01 (docs §4.4): a pull met a remote rotated on another device. The
// session locks and prompts for the new passphrase instead of the next local
// push silently reverting the rotation.
export const remoteRekeyed = signal(false)

const localWriteEpoch = signal(0)
const remoteSyncNotBefore = signal(0)
let remoteSyncQueue: Promise<unknown> = Promise.resolve()

// ── Remote store injection (docs §6.4) ───────────────────────────────────────
//
// The orchestration (persistence.ts constructs it) injects the cached()
// composition; every pull and push goes through the store, which owns the codec
// and the crypto. Secrets never transit this module.

let remoteStore: DocStore | null = null

export function setRemoteStore(store: DocStore | null) {
    remoteStore = store
}

export function getRemoteStore(): DocStore | null {
    return remoteStore
}

function requireRemoteStore(): DocStore {
    if (!remoteStore) throw new StoreError('unauthenticated', 'No remote session is active.')
    return remoteStore
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

export function getLastSyncedAt() {
    return parseInt(store.syncTs.get('0') || '0') || 0
}

export function setLastSyncedAt(ts: number) {
    store.syncTs.set(String(ts))
}

// ── Typing gate and write epochs ─────────────────────────────────────────────

export function noteLocalWriteActivity(now = Date.now()) {
    localWriteEpoch.value = localWriteEpoch.peek() + 1
    remoteSyncNotBefore.value = Math.max(
        remoteSyncNotBefore.peek(),
        now + outline.dirtyDebounceTimeout
    )
}

export function createRemoteSyncAttempt(): RemoteSyncAttempt {
    return { epoch: localWriteEpoch.peek() }
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

/** Serialises every sync step, so a poll can never interleave with a save or a
 * conflict resolution. */
export function runExclusiveRemoteSync<T>(work: () => Promise<T>): Promise<T> {
    const run = remoteSyncQueue.then(work, work)
    remoteSyncQueue = run.catch(() => { })
    return run
}

// ── Retry policy (docs §6.4) ─────────────────────────────────────────────────

/**
 * Retry base delay. `window.__retryBaseMs` is a Playwright seam: it is read
 * only in the test bundle (struct-06), so a same-origin script cannot zero the
 * backoff in production and hammer the server with retries.
 */
export function resolveRetryBaseMs(): number {
    if (typeof __TEST_HOOKS__ !== 'undefined' && __TEST_HOOKS__ && typeof window !== 'undefined') {
        const override = window.__retryBaseMs
        if (typeof override === 'number' && Number.isFinite(override) && override >= 1) return override
    }
    return 500
}

/**
 * Retries only the typed failures a retry can fix: transport/5xx (`network`)
 * and a session that is temporarily missing (`unauthenticated`). Everything
 * else — a rotated remote, an oversized document, rejected input — throws
 * immediately, because the same request cannot succeed on retry.
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    const baseMs = resolveRetryBaseMs()
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn()
        } catch (err) {
            if (i === maxRetries) throw err
            if (err instanceof StoreError && err.code !== 'network' && err.code !== 'unauthenticated') throw err
            await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)))
        }
    }
    throw new Error('retryWithBackoff exhausted all attempts')
}

// ── Pull-before-push ─────────────────────────────────────────────────────────

interface PullAndMergeResult {
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
async function pullAndMerge(): Promise<PullAndMergeResult> {
    const remote = requireRemoteStore()

    const remoteDoc = await remote.read()
    if (!remoteDoc) {
        return { clean: true, mergedJson: null, needsPush: true }
    }

    const localDoc = outline.snapshot()
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

// ── Typed-failure helper ─────────────────────────────────────────────────────

/**
 * Maps a failed sync step onto the status/notice surfaces. A remote-rekeyed
 * failure only raises the prompt: it is never followed by an upload. A size
 * rejection maps to the dedicated too-large status: it is permanent until the
 * user trims or moves the document, so it must not read as a transient error.
 */
function handleSyncFailure(error: unknown) {
    if (error instanceof StoreError && error.code === 'remote-rekeyed') {
        // sync-01: never swallowed, never followed by a push.
        remoteRekeyed.value = true
        syncStatus.value = 'error'
        return
    }
    if (error instanceof StoreError && error.code === 'too-large') {
        // The server refused the document for size (413 or the row's size-cap
        // check): retrying the same bytes cannot succeed, and the fix is the
        // user's — trim the document, or export/move it.
        log('[Sync] document rejected for size:', error)
        syncStatus.value = 'too-large'
        return
    }
    log('[Sync] sync step failed:', error)
    syncStatus.value = navigator.onLine === false ? 'offline' : 'error'
}

// ── The one sync step ────────────────────────────────────────────────────────

/** Adopt a merged document: it is the new remote state, so record its token
 * clock and apply it locally without triggering a second upload. */
function applyMerged(mergedJson: string) {
    setLastSyncedAt(Date.now())
    skipNextRemotePush.value = true
    outline.deserialize(mergedJson)
}

/** One upload through the store: the retry policy and the head-token adoption. */
async function upload(remote: DocStore, doc: OutlineDoc): Promise<void> {
    const token = await retryWithBackoff(() => remote.write(doc))
    if (token) setSyncHead(token)
}

/**
 * One pull-before-push step. Returns what happened; never throws.
 *
 * - `skipped` — nothing ran (no session, still typing, superseded, or already
 *   applied from a merge); the caller decides whether to retry.
 * - `conflict` — the merge needs the user; the blocking conflict flow owns the
 *   upload from here.
 * - `merged` — a newer remote was merged and applied locally; `pushed` says
 *   whether the merged document also had to be written back.
 * - `pushed` — a local document reached the server.
 * - `unchanged` — the poll found the head token unchanged.
 * - `failed` — the failure was already mapped onto the sync status.
 */
export function syncOnce(step: SyncStep): Promise<SyncOutcome> {
    return runExclusiveRemoteSync(() => runSyncStep(step))
}

async function runSyncStep({ doc, attempt }: SyncStep): Promise<SyncOutcome> {
    const remote = remoteStore
    if (!remote) return { kind: 'skipped', reason: 'no-remote' }
    // A pending merge owns the upload: never push around it.
    if (pendingConflicts.peek().length > 0) return { kind: 'conflict' }
    if (!canStartRemoteSync()) return { kind: 'skipped', reason: 'typing' }
    // The gate above covers the time half of staleness; this is the write half.
    if (attempt.epoch !== localWriteEpoch.peek()) return { kind: 'skipped', reason: 'stale' }

    // Change detection is the opaque head token, compared for inequality only.
    // A failed probe is "no head yet": a save still pushes, a poll does not.
    let head: string | null = null
    try {
        head = await remote.head?.() ?? null
    } catch { /* proceed with a direct write */ }
    if (attempt.epoch !== localWriteEpoch.peek()) return { kind: 'skipped', reason: 'stale' }

    const remoteChanged = !!head && head !== getLastSyncHead()
    if (!remoteChanged && !doc) return { kind: 'unchanged' }

    try {
        if (remoteChanged) {
            syncStatus.value = 'syncing'
            const result = await pullAndMerge()
            if (attempt.epoch !== localWriteEpoch.peek()) return { kind: 'skipped', reason: 'stale' }
            if (!result.clean) {
                syncStatus.value = 'synced'
                return { kind: 'conflict' }
            }
            if (result.mergedJson) {
                if (result.needsPush) {
                    // Check staleness BEFORE the upload: once the merged document
                    // is on the server, bailing out without applying it leaves the
                    // server holding content the local doc never adopts, and the
                    // next save overwrites the remote side's edits.
                    if (attempt.epoch !== localWriteEpoch.peek()) return { kind: 'skipped', reason: 'stale' }
                    await upload(remote, jsonCodec.parse(result.mergedJson))
                    // An edit that landed during the upload must survive the
                    // apply: fold the live document into the just-uploaded merge
                    // result instead of clobbering it. The live edit is newer
                    // than both merge inputs, so the fold is clean unless the
                    // same node was edited on both sides — which opens the
                    // conflict flow like any pull does.
                    if (attempt.epoch !== localWriteEpoch.peek()) {
                        const liveDoc = outline.snapshot()
                        const refolded = merge(liveDoc, jsonCodec.parse(result.mergedJson), getLastSyncedAt())
                        if (refolded.kind === 'conflict') {
                            pendingConflicts.value = refolded.conflicts
                            pendingMergedDoc.value = refolded.partial
                            pendingConflictResolutions.value = new Map()
                            return { kind: 'conflict' }
                        }
                        // Not applyMerged: the folded document still owes the
                        // server the live edit, so the deserialize-triggered
                        // save must push it (applyMerged would skip that push).
                        setLastSyncedAt(Date.now())
                        outline.deserialize(jsonCodec.serialize(refolded.doc))
                        syncStatus.value = 'synced'
                        return { kind: 'merged', pushed: true }
                    }
                } else {
                    // The remote already has this content; adopt its token
                    // instead of creating an identical revision.
                    if (head) setSyncHead(head)
                }
                applyMerged(result.mergedJson)
                syncStatus.value = 'synced'
                return { kind: 'merged', pushed: result.needsPush }
            }
        }

        if (!doc) return { kind: 'unchanged' }

        syncStatus.value = 'syncing'
        await upload(remote, doc)
        if (attempt.epoch === localWriteEpoch.peek()) {
            setLastSyncedAt(Date.now())
            syncStatus.value = 'synced'
        }
        return { kind: 'pushed' }
    } catch (error) {
        if (attempt.epoch !== localWriteEpoch.peek()) return { kind: 'skipped', reason: 'stale' }
        handleSyncFailure(error)
        return { kind: 'failed', error }
    }
}

// ── Conflict resolution ──────────────────────────────────────────────────────

/**
 * Apply a chosen parent to a node inside the conflict document, keeping both
 * parents' children arrays true (data-02: a resolved move must not leave the
 * node listed under its old parent).
 */
function reparent(nodes: OutlineNode[], node: OutlineNode, nextParentId: string | null) {
    const previousParentId = node.parentId ?? null
    if (previousParentId === nextParentId) return
    const previousParent = nodes.find(candidate => candidate.id === previousParentId)
    if (previousParent) {
        previousParent.children = (previousParent.children ?? []).filter(id => id !== node.id)
    }
    const nextParent = nodes.find(candidate => candidate.id === nextParentId)
    if (nextParent && !(nextParent.children ?? []).includes(node.id)) {
        nextParent.children = [...(nextParent.children ?? []), node.id]
    }
    node.parentId = nextParentId
}

/**
 * Apply the user's conflict resolutions, upload the merged document and clear
 * the conflict state. The upload happens here, not through `syncOnce`: the
 * merged document is the decision, so it must not be merged again.
 */
export async function resolveConflicts(resolutions: ConflictResolution[]) {
    const doc = pendingMergedDoc.peek()
    if (!doc) return

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

    // Apply chosen values to the merged nodes. Every field merge can flag is
    // applied here (CONFLICT_FIELDS), so resolving one always has an effect.
    const updatedNodes = doc.nodes.map(node => ({ ...node, children: [...(node.children ?? [])] }))
    for (const node of updatedNodes) {
        for (const field of CONFLICT_FIELDS) {
            const key = `${node.id}::${field}`
            const side = choiceMap.get(key)
            if (!side) continue
            const vals = conflictValues.get(key)
            if (!vals) continue
            if (field === 'parentId') {
                reparent(updatedNodes, node, vals[side] ?? null)
            } else {
                (node as Record<string, unknown>)[field] = vals[side]
            }
        }
    }

    // data-04: a `children` conflict takes one whole array, so a node only the
    // losing side listed would be left in the document but unreachable.
    const mergedObj: OutlineDoc = { ...doc, nodes: attachMissingChildren(updatedNodes) }

    await runExclusiveRemoteSync(async () => {
        // The conflict flow only exists inside a live Remote session.
        const remote = requireRemoteStore()
        try {
            syncStatus.value = 'syncing'
            await upload(remote, mergedObj)
            setLastSyncedAt(Date.now())
            syncStatus.value = 'synced'
        } catch (err) {
            log('[Sync] resolveConflicts push failed:', err)
            handleSyncFailure(err)
        }
    })

    // Apply the decision locally; the save it triggers must not re-upload it.
    skipNextRemotePush.value = true
    outline.deserialize(jsonCodec.serialize(mergedObj))

    pendingConflicts.value = []
    pendingMergedDoc.value = null
    pendingConflictResolutions.value = new Map()
}
