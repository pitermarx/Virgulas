import { mergeDocuments } from './sync.js'
import {
    assert,
    assertEqual,
    cloneSections,
    createAsyncSectionHarness,
    streamCompletedSections,
    summaryFromSections
} from './testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

export function summary() {
    return summaryFromSections(sections)
}

export async function streamSyncTests(onProgress) {
    return streamCompletedSections(cloneSections(sections), onProgress, 10)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function node(overrides) {
    return {
        id: 'n1',
        text: 'Hello',
        description: '',
        children: [],
        parentId: 'root',
        open: true,
        lastModified: 0,
        ...overrides
    }
}

function baseNodes(extra = []) {
    return [
        { id: 'root', text: '', description: '', children: extra.map(n => n.id), parentId: null, open: true, lastModified: 0 },
        ...extra
    ]
}

const T0 = 1000   // base time
const T1 = 2000   // modified after last sync
const T2 = 3000   // also modified after last sync, but by other side
const SYNCED_AT = 1500  // lastSyncedAt is between T0 and T1

// ─── tests ───────────────────────────────────────────────────────────────────

section("mergeDocuments — one-side-only changes")

await test("Only local modified → local wins, no conflicts", () => {
    const local = baseNodes([node({ id: 'n1', text: 'Local text', lastModified: T1 })])
    const remote = baseNodes([node({ id: 'n1', text: 'Original', lastModified: T0 })])
    const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    assertEqual(conflicts.length, 0, "No conflicts expected")
    const n = merged.find(n => n.id === 'n1')
    assertEqual(n?.text, 'Local text', "Local version should win")
})

await test("Only remote modified → remote wins, no conflicts", () => {
    const local = baseNodes([node({ id: 'n1', text: 'Original', lastModified: T0 })])
    const remote = baseNodes([node({ id: 'n1', text: 'Remote text', lastModified: T1 })])
    const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    assertEqual(conflicts.length, 0, "No conflicts expected")
    const n = merged.find(n => n.id === 'n1')
    assertEqual(n?.text, 'Remote text', "Remote version should win")
})

await test("Neither side modified → local is kept, no conflicts", () => {
    const local = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T0 })])
    const remote = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T0 })])
    const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    assertEqual(conflicts.length, 0, "No conflicts expected for unmodified nodes")
    assertEqual(merged.find(n => n.id === 'n1')?.text, 'Same', "Local kept")
})

section("mergeDocuments — both sides modified → conflicts")

await test("Both sides changed text → text conflict", () => {
    const local = baseNodes([node({ id: 'n1', text: 'Local', lastModified: T1 })])
    const remote = baseNodes([node({ id: 'n1', text: 'Remote', lastModified: T2 })])
    const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'text')
    assert(c !== undefined, "Should have a text conflict")
    assertEqual(c.localValue, 'Local', "Local value")
    assertEqual(c.remoteValue, 'Remote', "Remote value")
})

await test("Both sides changed description → description conflict", () => {
    const local = baseNodes([node({ id: 'n1', description: 'Local desc', lastModified: T1 })])
    const remote = baseNodes([node({ id: 'n1', description: 'Remote desc', lastModified: T2 })])
    const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'description')
    assert(c !== undefined, "Should have a description conflict")
})

await test("Both sides changed children → children conflict", () => {
    const local = baseNodes([node({ id: 'n1', children: ['c1'], lastModified: T1 })])
    const remote = baseNodes([node({ id: 'n1', children: ['c2'], lastModified: T2 })])
    const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'children')
    assert(c !== undefined, "Should have a children conflict")
})

await test("Both sides same field value → no conflict", () => {
    const local = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T1 })])
    const remote = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T2 })])
    const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'text')
    assert(c === undefined, "Same value should not produce a conflict")
})

await test("open field uses last-writer-wins, never conflicts", () => {
    // local is more recent (T2 > T1), so its `open` value wins
    const local = baseNodes([node({ id: 'n1', open: false, lastModified: T2 })])
    const remote = baseNodes([node({ id: 'n1', open: true, lastModified: T1 })])
    const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    const openConflicts = conflicts.filter(c => c.field === 'open')
    assertEqual(openConflicts.length, 0, "open should never conflict")
    assertEqual(merged.find(n => n.id === 'n1')?.open, false, "Local (more recent) open wins")
})

section("mergeDocuments — node presence")

await test("Node added locally (not in remote) → kept", () => {
    const localNode = node({ id: 'new-local', text: 'New', lastModified: T1 })
    const local = baseNodes([localNode])
    const remote = baseNodes([])   // remote has no 'new-local'
    // Also remove 'new-local' from root.children in remote
    const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'new-local') !== undefined, "Locally-added node should be kept")
    assertEqual(conflicts.length, 0, "No conflicts")
})

await test("Node added remotely (not in local) → kept", () => {
    const remoteNode = node({ id: 'new-remote', text: 'New', lastModified: T1 })
    const local = baseNodes([])
    const remote = baseNodes([remoteNode])
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'new-remote') !== undefined, "Remotely-added node should be kept")
})

await test("Node deleted locally (was in remote, unmodified) → omitted", () => {
    const existingNode = node({ id: 'n1', text: 'Old', lastModified: T0 })
    // local doesn't have n1 (deleted), remote still has it unmodified
    const local = baseNodes([])
    const remote = baseNodes([existingNode])
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'n1') === undefined, "Unmodified remote-only node should be omitted (deleted locally)")
})

await test("Node deleted locally but modified remotely → kept (remote wins)", () => {
    // n1 not in local (deleted), but remote modified it after lastSyncedAt
    const remoteNode = node({ id: 'n1', text: 'Modified remotely', lastModified: T1 })
    const local = baseNodes([])
    const remote = baseNodes([remoteNode])
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'n1') !== undefined, "Remote-modified node should survive local deletion")
})

await test("Node deleted remotely (was in local, unmodified) → omitted", () => {
    const existingNode = node({ id: 'n1', text: 'Old', lastModified: T0 })
    const local = baseNodes([existingNode])
    const remote = baseNodes([])  // n1 deleted remotely
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'n1') === undefined, "Unmodified local-only node should be omitted (deleted remotely)")
})

await test("Node deleted remotely but modified locally → kept (local wins)", () => {
    const localNode = node({ id: 'n1', text: 'Modified locally', lastModified: T1 })
    const local = baseNodes([localNode])
    const remote = baseNodes([])   // n1 deleted remotely
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'n1') !== undefined, "Locally-modified node should survive remote deletion")
})

section("mergeDocuments — special cases")

await test("Root node is never deleted even if absent from one side", () => {
    // Simulate local having root, remote not (shouldn't happen, but defensive)
    const local = [{ id: 'root', text: '', children: [], parentId: null, lastModified: 0 }]
    const remote = []  // no root in remote
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    assert(merged.find(n => n.id === 'root') !== undefined, "Root must always be present")
})

await test("Old docs (lastModified=0) treated as unmodified", () => {
    // Both sides have lastModified=0 → both 'unmodified', local is kept
    const local = baseNodes([node({ id: 'n1', text: 'Local', lastModified: 0 })])
    const remote = baseNodes([node({ id: 'n1', text: 'Remote', lastModified: 0 })])
    const { merged, conflicts } = mergeDocuments(local, remote, 0)
    assertEqual(conflicts.length, 0, "No conflicts for zero-lastModified nodes")
    assertEqual(merged.find(n => n.id === 'n1')?.text, 'Local', "Local kept when both unmodified")
})

await test("Tree integrity: node with missing parent is dropped", () => {
    // n2 references parentId 'n1', but n1 is absent from merged
    const orphan = { id: 'n2', text: 'Orphan', children: [], parentId: 'n1', lastModified: T1 }
    // n1 is deleted locally, not modified remotely → should be omitted
    const existingRemote = node({ id: 'n1', text: 'Parent', lastModified: T0 })
    const local = [
        { id: 'root', text: '', children: [], parentId: null, lastModified: 0 },
        orphan  // orphan was added locally but references a parent being deleted
    ]
    const remote = [
        { id: 'root', text: '', children: ['n1'], parentId: null, lastModified: 0 },
        existingRemote
    ]
    const { merged } = mergeDocuments(local, remote, SYNCED_AT)
    // n1 is remote-only and unmodified (localChanged=false, remoteChanged=false since T0<SYNCED_AT=1500)
    // Actually T0=1000 < SYNCED_AT=1500, so remoteChanged=false → n1 is treated as deleted locally → omitted
    // n2 is local-only with T1>SYNCED_AT → kept but parent n1 is gone → dropped by integrity check
    assert(merged.find(n => n.id === 'n2') === undefined, "Orphaned node should be dropped")
})

await test("Different nodes modified on each side → both changes kept, no conflicts", () => {
    const localNode1 = node({ id: 'n1', text: 'Local edit', lastModified: T1 })
    const remoteNode2 = node({ id: 'n2', text: 'Remote edit', parentId: 'root', lastModified: T2 })
    const local = [
        { id: 'root', text: '', children: ['n1'], parentId: null, lastModified: 0 },
        localNode1
    ]
    const remote = [
        { id: 'root', text: '', children: ['n2'], parentId: null, lastModified: 0 },
        remoteNode2
    ]
    const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
    assertEqual(conflicts.length, 0, "No conflicts when different nodes changed")
    assert(merged.find(n => n.id === 'n1') !== undefined, "Locally-modified n1 present")
    assert(merged.find(n => n.id === 'n2') !== undefined, "Remotely-modified n2 present")
})
