// Pure three-way merge over the outline model
// (docs/storage-interface.md §4.6, rollout PR 1).
//
// Extracted verbatim from sync.ts so the merge algorithm is a pure function
// over document values — no store I/O, no Supabase knowledge, no signals.
// sync.ts re-exports mergeDocuments for the e2e seam; the doc-level merge()
// is the contract the storage seam's orchestration consumes.
//
// Two clocks, deliberately (docs §8): the numeric baseline (epoch ms of the
// last successful sync, per-node lastModified comparison) is merge state
// owned by the orchestration; the opaque head() change token is a separate
// concern that never appears here.

import { log } from './utils.js'
import type { OutlineDoc, OutlineNode } from './docCodec.js'

export interface NodeConflict {
    nodeId: string
    nodeText: string
    field: string
    localValue: any
    remoteValue: any
}

export type MergeResult =
    | { kind: 'merged'; doc: OutlineDoc }
    | { kind: 'conflict'; conflicts: NodeConflict[]; partial: OutlineDoc }

/**
 * Merges two node arrays (local + remote) using per-node lastModified timestamps.
 *
 * @param {object[]} localNodes  - nodes from outline.serialize()
 * @param {object[]} remoteNodes - nodes decrypted from remote
 * @param {number}   lastSyncedAt - epoch ms of last successful sync (0 = never)
 * @returns {{ merged: object[], conflicts: object[] }}
 */
export function mergeDocuments(localNodes: OutlineNode[], remoteNodes: OutlineNode[], lastSyncedAt: number): { merged: OutlineNode[]; conflicts: NodeConflict[] } {
    const localMap = new Map<string, OutlineNode>(localNodes.map(n => [n.id, n]))
    const remoteMap = new Map<string, OutlineNode>(remoteNodes.map(n => [n.id, n]))

    const merged: OutlineNode[] = []
    const conflicts: NodeConflict[] = []

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
            const rootNode = local || remote
            if (rootNode) merged.push(rootNode)
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
        if (!local || !remote) continue
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
        if (!mergedIds.has(n.parentId ?? '')) {
            log(`[Sync] Node ${n.id} has missing parent ${n.parentId}, dropping from merge`)
            return false
        }
        return true
    })

    return { merged: valid, conflicts }
}

/**
 * Document-level three-way merge. Same-node different-field edits auto-merge
 * (kind 'merged'); same-field edits produce the blocking conflict set plus the
 * auto-merged partial document the conflict modal operates on (kind
 * 'conflict'). Document-level metadata (modelVersion, dataVersion, …) is
 * carried over from the local document, exactly as the sync flow did before
 * the extraction.
 *
 * @param local   the local document (from outline.serialize())
 * @param remote  the remote document (decrypted from the backend)
 * @param baseline epoch ms of the last successful sync (0 = never)
 */
export function merge(local: OutlineDoc, remote: OutlineDoc, baseline: number): MergeResult {
    const { merged, conflicts } = mergeDocuments(local.nodes, remote.nodes, baseline)
    if (conflicts.length > 0) {
        return { kind: 'conflict', conflicts, partial: { ...local, nodes: merged } }
    }
    return { kind: 'merged', doc: { ...local, nodes: merged } }
}

/**
 * Whether two documents have the same user-visible content.
 *
 * Used after a pull to decide if the merged result needs a write-back. Node
 * order, the local `dataVersion` counter and per-node `lastModified` stamps
 * are bookkeeping, not content: a pull that only changed those must not create
 * a new remote revision (which would make every other client pull again).
 * Unknown fields are still compared, so future document data cannot be
 * silently skipped.
 */
export function documentsEquivalent(a: OutlineDoc, b: OutlineDoc): boolean {
    return canonicalDocument(a) === canonicalDocument(b)
}

function canonicalDocument(doc: OutlineDoc): string {
    const canonical: Record<string, unknown> = {}
    for (const key of Object.keys(doc).sort()) {
        if (key === 'nodes' || key === 'dataVersion') continue
        const value = doc[key]
        if (value === undefined) continue
        canonical[key] = canonicalValue(value)
    }
    canonical.nodes = [...doc.nodes]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map(canonicalNode)
    return JSON.stringify(canonical)
}

function canonicalNode(node: OutlineNode): unknown {
    const rest: Record<string, unknown> = { ...node }
    delete rest.lastModified
    return canonicalValue({
        ...rest,
        parentId: node.parentId ?? null,
        text: node.text ?? '',
        description: node.description ?? '',
        children: node.children ?? [],
        open: node.open === undefined ? true : !!node.open,
        done: node.done ?? null
    })
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (value && typeof value === 'object') {
        const canonical: Record<string, unknown> = {}
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const entry = (value as Record<string, unknown>)[key]
            if (entry === undefined) continue
            canonical[key] = canonicalValue(entry)
        }
        return canonical
    }
    return value
}
