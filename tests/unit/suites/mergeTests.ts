// Unit suite for the pure merge module (storage seam PR 1, docs §4.6/§10).
// mergeDocuments' node-level behaviour is already covered by the sync suite
// (it now re-exports the extracted function); this suite covers the
// document-level merge() contract: the merged/conflict result shape,
// metadata carry-over, baseline semantics, and pureness.
import { merge, mergeDocuments } from '../../../source/js/merge.js'
import type { OutlineDoc, OutlineNode } from '../../../source/js/docCodec.js'
import {
    assert,
    assertEqual,
    createAsyncSectionHarness
} from '../testing.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

// ─── helpers ─────────────────────────────────────────────────────────────────

function node(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
    return {
        text: 'Hello',
        description: '',
        children: [],
        parentId: 'root',
        open: true,
        lastModified: 0,
        ...overrides
    } as OutlineNode
}

function doc(nodes: OutlineNode[]): OutlineDoc {
    return {
        modelVersion: 'v1',
        dataVersion: 7,
        nodes: [node({ id: 'root', text: '', parentId: null, children: nodes.map(n => n.id) }), ...nodes]
    }
}

const T0 = 1000
const T1 = 2000
const T2 = 3000
const SYNCED_AT = 1500

// ─── tests ───────────────────────────────────────────────────────────────────

section('merge — merged result shape')

await test('auto-merge of one-sided changes returns the merged document', () => {
    const local = doc([node({ id: 'n1', text: 'Local text', lastModified: T1 })])
    const remote = doc([node({ id: 'n1', text: 'Original', lastModified: T0 })])

    const result = merge(local, remote, SYNCED_AT)

    assertEqual(result.kind, 'merged', 'one-sided change auto-merges')
    if (result.kind !== 'merged') return
    const mergedN1 = result.doc.nodes.find(n => n.id === 'n1')
    assertEqual(mergedN1?.text, 'Local text', 'newer local text wins')
    assertEqual(result.doc.nodes.length, 2, 'root + n1')
})

await test('document-level metadata is carried over from the local document', () => {
    const local = doc([node({ id: 'n1', lastModified: T0 })])
    const remote = doc([node({ id: 'n1', lastModified: T0 })])
    remote.dataVersion = 99

    const result = merge(local, remote, SYNCED_AT)

    assertEqual(result.kind, 'merged', 'no changes anywhere')
    if (result.kind !== 'merged') return
    assertEqual(result.doc.modelVersion, 'v1', 'modelVersion from local')
    assertEqual(result.doc.dataVersion, 7, 'dataVersion from local, not remote')
})

await test('the merged document round-trips through JSON identically to the pre-extraction flow', () => {
    // The old flow produced `{ ...localObj, nodes: merged }` stringified.
    const local = doc([node({ id: 'n1', text: 'A', lastModified: T1 })])
    const remote = doc([node({ id: 'n1', text: 'A', lastModified: T0 })])

    const result = merge(local, remote, SYNCED_AT)

    if (result.kind !== 'merged') throw new Error('expected a merged result')
    const roundTripped = JSON.parse(JSON.stringify(result.doc))
    assertEqual(roundTripped.modelVersion, 'v1', 'metadata survives stringification')
    assertEqual(roundTripped.nodes.length, 2, 'nodes survive stringification')
})

section('merge — conflict result shape')

await test('same-field edits produce the conflict set and the auto-merged partial', () => {
    const local = doc([
        node({ id: 'n1', text: 'Local text', description: 'same', lastModified: T1 }),
        node({ id: 'n2', text: 'kept', lastModified: T1 })
    ])
    const remote = doc([
        node({ id: 'n1', text: 'Remote text', description: 'same', lastModified: T2 }),
        node({ id: 'n2', text: 'kept', lastModified: T2 })
    ])

    const result = merge(local, remote, SYNCED_AT)

    assertEqual(result.kind, 'conflict', 'same-field edit conflicts')
    if (result.kind !== 'conflict') return
    assertEqual(result.conflicts.length, 1, 'only n1 text conflicts')
    assertEqual(result.conflicts[0].nodeId, 'n1', 'conflict nodeId')
    assertEqual(result.conflicts[0].field, 'text', 'conflict field')
    assertEqual(result.conflicts[0].localValue, 'Local text', 'conflict local value')
    assertEqual(result.conflicts[0].remoteValue, 'Remote text', 'conflict remote value')
    // The partial keeps both nodes (the modal operates on it)
    assertEqual(result.partial.nodes.length, 3, 'partial has root + n1 + n2')
    assertEqual(result.partial.modelVersion, 'v1', 'partial keeps local metadata')
})

await test('a one-sided change carries every field of the winning side, not just text', () => {
    const local = doc([node({ id: 'n1', text: 'new text', description: 'new desc', lastModified: T1 })])
    const remote = doc([node({ id: 'n1', text: 'old text', description: 'old desc', lastModified: T0 })])

    const result = merge(local, remote, SYNCED_AT)

    if (result.kind !== 'merged') throw new Error('expected a merged result')
    const n1 = result.doc.nodes.find(n => n.id === 'n1')
    assertEqual(n1?.text, 'new text', 'local text wins')
    assertEqual(n1?.description, 'new desc', 'local description carries over too')
})

section('merge — baseline semantics')

await test('nodes not modified since the baseline are kept as-is', () => {
    const local = doc([node({ id: 'n1', text: 'same', lastModified: T0 })])
    const remote = doc([node({ id: 'n1', text: 'same', lastModified: T0 })])

    const result = merge(local, remote, SYNCED_AT)

    assertEqual(result.kind, 'merged', 'unchanged on both sides')
})

await test('baseline 0 treats every node as changed', () => {
    const local = doc([node({ id: 'n1', text: 'local', lastModified: T0 })])
    const remote = doc([node({ id: 'n1', text: 'remote', lastModified: T0 })])

    const result = merge(local, remote, 0)

    assertEqual(result.kind, 'conflict', 'both "changed" at baseline 0 → conflict')
})

await test('the root node survives regardless of timestamps', () => {
    const local = doc([])
    const remote = doc([node({ id: 'n1', lastModified: T0 })])

    const result = merge(local, remote, SYNCED_AT)

    if (result.kind !== 'merged') throw new Error('expected a merged result')
    assert(result.doc.nodes.some(n => n.id === 'root'), 'root always present')
})

section('merge — equivalence with mergeDocuments')

await test('merge() delegates to mergeDocuments and wraps its output verbatim', () => {
    const localNodes = [
        node({ id: 'root', text: '', parentId: null, children: ['n1'], lastModified: 0 }),
        node({ id: 'n1', text: 'Local text', lastModified: T1 })
    ]
    const remoteNodes = [
        node({ id: 'root', text: '', parentId: null, children: ['n1'], lastModified: 0 }),
        node({ id: 'n1', text: 'Original', lastModified: T0 })
    ]
    const localDoc: OutlineDoc = { modelVersion: 'v1', nodes: localNodes }

    const nodeLevel = mergeDocuments(localNodes, remoteNodes, SYNCED_AT)
    const docLevel = merge(localDoc, { nodes: remoteNodes }, SYNCED_AT)

    if (docLevel.kind !== 'merged') throw new Error('expected a merged result')
    assertEqual(JSON.stringify(docLevel.doc.nodes), JSON.stringify(nodeLevel.merged), 'same merged nodes')
})

section('merge — pureness')

await test('merge has no functional store dependency (works with localStorage poisoned)', () => {
    const local = doc([node({ id: 'n1', text: 'A', lastModified: T1 })])
    const remote = doc([node({ id: 'n1', text: 'B', lastModified: T2 })])

    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const throwing = {
        get() { throw new Error('merge must not touch localStorage') },
        set() { throw new Error('merge must not touch localStorage') }
    }
    Object.defineProperty(globalThis, 'localStorage', { ...throwing, configurable: true })
    try {
        const result = merge(local, remote, SYNCED_AT)
        assertEqual(result.kind, 'conflict', 'merge still works with storage poisoned')
    } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original)
        else delete (globalThis as any).localStorage
    }
})
