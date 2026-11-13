import { describe, it } from 'bun:test'
import { mergeDocuments, resolveConflicts, setRemoteStore, pendingConflicts, pendingMergedDoc } from '../../../source/js/sync.js'
import outline from '../../../source/js/outline.js'
import { assert, assertEqual } from '../testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

// ─── helpers ─────────────────────────────────────────────────────────────────

function node(overrides: any): any {
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

function baseNodes(extra: any[] = []): any[] {
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


describe("mergeDocuments — one-side-only changes", () => {

  it("Only local modified → local wins, no conflicts", () => {
      const local = baseNodes([node({ id: 'n1', text: 'Local text', lastModified: T1 })])
      const remote = baseNodes([node({ id: 'n1', text: 'Original', lastModified: T0 })])
      const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      assertEqual(conflicts.length, 0, "No conflicts expected")
      const n = merged.find(n => n.id === 'n1')
      assertEqual(n?.text, 'Local text', "Local version should win")
  })

  it("Only remote modified → remote wins, no conflicts", () => {
      const local = baseNodes([node({ id: 'n1', text: 'Original', lastModified: T0 })])
      const remote = baseNodes([node({ id: 'n1', text: 'Remote text', lastModified: T1 })])
      const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      assertEqual(conflicts.length, 0, "No conflicts expected")
      const n = merged.find(n => n.id === 'n1')
      assertEqual(n?.text, 'Remote text', "Remote version should win")
  })

  it("Neither side modified → local is kept, no conflicts", () => {
      const local = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T0 })])
      const remote = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T0 })])
      const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      assertEqual(conflicts.length, 0, "No conflicts expected for unmodified nodes")
      assertEqual(merged.find(n => n.id === 'n1')?.text, 'Same', "Local kept")
  })
})

describe("mergeDocuments — both sides modified → conflicts", () => {

  it("Both sides changed text → text conflict", () => {
      const local = baseNodes([node({ id: 'n1', text: 'Local', lastModified: T1 })])
      const remote = baseNodes([node({ id: 'n1', text: 'Remote', lastModified: T2 })])
      const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'text')
      assert(c !== undefined, "Should have a text conflict")
      assertEqual(c.localValue, 'Local', "Local value")
      assertEqual(c.remoteValue, 'Remote', "Remote value")
  })

  it("Both sides changed description → description conflict", () => {
      const local = baseNodes([node({ id: 'n1', description: 'Local desc', lastModified: T1 })])
      const remote = baseNodes([node({ id: 'n1', description: 'Remote desc', lastModified: T2 })])
      const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'description')
      assert(c !== undefined, "Should have a description conflict")
  })

  it("Both sides changed children → children conflict", () => {
      const local = baseNodes([node({ id: 'n1', children: ['c1'], lastModified: T1 })])
      const remote = baseNodes([node({ id: 'n1', children: ['c2'], lastModified: T2 })])
      const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'children')
      assert(c !== undefined, "Should have a children conflict")
  })

  it("Both sides same field value → no conflict", () => {
      const local = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T1 })])
      const remote = baseNodes([node({ id: 'n1', text: 'Same', lastModified: T2 })])
      const { conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      const c = conflicts.find(c => c.nodeId === 'n1' && c.field === 'text')
      assert(c === undefined, "Same value should not produce a conflict")
  })

  it("open field uses last-writer-wins, never conflicts", () => {
      // local is more recent (T2 > T1), so its `open` value wins
      const local = baseNodes([node({ id: 'n1', open: false, lastModified: T2 })])
      const remote = baseNodes([node({ id: 'n1', open: true, lastModified: T1 })])
      const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      const openConflicts = conflicts.filter(c => c.field === 'open')
      assertEqual(openConflicts.length, 0, "open should never conflict")
      assertEqual(merged.find(n => n.id === 'n1')?.open, false, "Local (more recent) open wins")
  })
})

describe("mergeDocuments — node presence", () => {

  it("Node added locally (not in remote) → kept", () => {
      const localNode = node({ id: 'new-local', text: 'New', lastModified: T1 })
      const local = baseNodes([localNode])
      const remote = baseNodes([])   // remote has no 'new-local'
      // Also remove 'new-local' from root.children in remote
      const { merged, conflicts } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'new-local') !== undefined, "Locally-added node should be kept")
      assertEqual(conflicts.length, 0, "No conflicts")
  })

  it("Node added remotely (not in local) → kept", () => {
      const remoteNode = node({ id: 'new-remote', text: 'New', lastModified: T1 })
      const local = baseNodes([])
      const remote = baseNodes([remoteNode])
      const { merged } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'new-remote') !== undefined, "Remotely-added node should be kept")
  })

  it("Node deleted locally (was in remote, unmodified) → omitted", () => {
      const existingNode = node({ id: 'n1', text: 'Old', lastModified: T0 })
      // local doesn't have n1 (deleted), remote still has it unmodified
      const local = baseNodes([])
      const remote = baseNodes([existingNode])
      const { merged } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'n1') === undefined, "Unmodified remote-only node should be omitted (deleted locally)")
  })

  it("Node deleted locally but modified remotely → kept (remote wins)", () => {
      // n1 not in local (deleted), but remote modified it after lastSyncedAt
      const remoteNode = node({ id: 'n1', text: 'Modified remotely', lastModified: T1 })
      const local = baseNodes([])
      const remote = baseNodes([remoteNode])
      const { merged } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'n1') !== undefined, "Remote-modified node should survive local deletion")
  })

  it("Node deleted remotely (was in local, unmodified) → omitted", () => {
      const existingNode = node({ id: 'n1', text: 'Old', lastModified: T0 })
      const local = baseNodes([existingNode])
      const remote = baseNodes([])  // n1 deleted remotely
      const { merged } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'n1') === undefined, "Unmodified local-only node should be omitted (deleted remotely)")
  })

  it("Node deleted remotely but modified locally → kept (local wins)", () => {
      const localNode = node({ id: 'n1', text: 'Modified locally', lastModified: T1 })
      const local = baseNodes([localNode])
      const remote = baseNodes([])   // n1 deleted remotely
      const { merged } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'n1') !== undefined, "Locally-modified node should survive remote deletion")
  })
})

describe("mergeDocuments — special cases", () => {

  it("Root node is never deleted even if absent from one side", () => {
      // Simulate local having root, remote not (shouldn't happen, but defensive)
      const local = [{ id: 'root', text: '', children: [], parentId: null, lastModified: 0 }]
      const remote: any[] = []  // no root in remote
      const { merged } = mergeDocuments(local, remote, SYNCED_AT)
      assert(merged.find(n => n.id === 'root') !== undefined, "Root must always be present")
  })

  it("Old docs (lastModified=0) treated as unmodified", () => {
      // Both sides have lastModified=0 → both 'unmodified', local is kept
      const local = baseNodes([node({ id: 'n1', text: 'Local', lastModified: 0 })])
      const remote = baseNodes([node({ id: 'n1', text: 'Remote', lastModified: 0 })])
      const { merged, conflicts } = mergeDocuments(local, remote, 0)
      assertEqual(conflicts.length, 0, "No conflicts for zero-lastModified nodes")
      assertEqual(merged.find(n => n.id === 'n1')?.text, 'Local', "Local kept when both unmodified")
  })

  it("Tree integrity: node with missing parent is dropped", () => {
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

  it("Different nodes modified on each side → both changes kept, no conflicts", () => {
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
})
describe('resolveConflicts applies every conflict field (data-02)', () => {

    it('applies a chosen task state and reparents the node, keeping both parents true', async () => {
        outline.reset()
        let writes = 0
        setRemoteStore({
            async read() { return null },
            async write() { writes += 1; return 'token' },
            async clear() { },
            async exists() { return true },
            async head() { return null },
            async unlock() { },
            async lock() { },
            capabilities: { durable: 'always', encrypted: false, authenticated: false, changeDetection: true, available: true }
        })
        pendingMergedDoc.value = {
            modelVersion: 'v1',
            dataVersion: 1,
            nodes: [
                { id: 'root', parentId: null, text: '', children: ['a', 'b'], lastModified: 0 },
                { id: 'a', parentId: 'root', text: 'A', children: ['n1'], lastModified: 0 },
                { id: 'b', parentId: 'root', text: 'B', children: [], lastModified: 0 },
                { id: 'n1', parentId: 'a', text: 'N', children: [], lastModified: 0, done: false }
            ]
        }
        pendingConflicts.value = [
            { nodeId: 'n1', nodeText: 'N', field: 'done', localValue: false, remoteValue: true },
            { nodeId: 'n1', nodeText: 'N', field: 'parentId', localValue: 'a', remoteValue: 'b' }
        ]

        await resolveConflicts([
            { nodeId: 'n1', field: 'done', chosenSide: 'remote' },
            { nodeId: 'n1', field: 'parentId', chosenSide: 'remote' }
        ])

        const n1 = outline.get('n1')!.peek()
        assertEqual(n1.done, true, 'the chosen task state is applied')
        assertEqual(n1.parentId, 'b', 'the chosen parent is applied')
        assertEqual(outline.get('a')!.peek().children.includes('n1'), false, 'the old parent no longer lists it')
        assertEqual(outline.get('b')!.peek().children.includes('n1'), true, 'the new parent lists it')
        assertEqual(writes, 1, 'the merged document was pushed once')
        setRemoteStore(null)
    })
})