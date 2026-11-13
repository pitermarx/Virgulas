// test-02: the suite asserts examples; these pin invariants that any example
// would have to obey. A failure here means a bug the example-based suites can
// miss, and the Phase 5 data-model work depends on them holding.
import { describe, it, beforeEach } from 'bun:test'
import outline from '../../../source/js/outline.js'
import { jsonCodec, type OutlineDoc, type OutlineNode } from '../../../source/js/docCodec.js'
import { merge, mergeDocuments } from '../../../source/js/merge.js'
import { assert, assertEqual } from '../testing.js'

beforeEach(() => outline.reset())

// ─── helpers ─────────────────────────────────────────────────────────────────

function childIds(id: string): string[] {
    return outline.get(id)?.peek().children ?? []
}

/** Every node reachable from the root exactly once, and every parent link true. */
function assertTreeInvariants(label: string) {
    const doc = outline.snapshot()
    const byId = new Map(doc.nodes.map((node) => [node.id, node]))
    assert(byId.has('root'), `${label}: the root node exists`)

    const seen = new Set<string>()
    const stack = ['root']
    while (stack.length > 0) {
        const id = stack.pop()!
        assert(!seen.has(id), `${label}: ${id} is reachable once (no cycle or shared child)`)
        seen.add(id)
        const node = byId.get(id)!
        for (const childId of node.children ?? []) {
            const child = byId.get(childId)
            assert(child, `${label}: ${id}'s child ${childId} exists`)
            assertEqual(child!.parentId ?? null, id, `${label}: ${childId} points back at ${id}`)
            stack.push(childId)
        }
    }
    assertEqual(seen.size, doc.nodes.length, `${label}: every node is reachable from root`)
}

/** Deterministic PRNG so a failing sequence is reproducible. */
function seeded(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function node(id: string, text: string, overrides: Partial<OutlineNode> = {}): OutlineNode {
    return {
        id,
        parentId: 'root',
        text,
        description: '',
        children: [],
        open: true,
        lastModified: 100,
        ...overrides
    }
}

function doc(...nodes: OutlineNode[]): OutlineDoc {
    return {
        modelVersion: 'v1',
        dataVersion: 0,
        nodes: [
            {
                id: 'root',
                parentId: null,
                text: '',
                description: '',
                children: nodes.map((n) => n.id),
                open: true,
                lastModified: 0
            },
            ...nodes
        ]
    }
}

function textOf(nodes: OutlineNode[], id: string): string | undefined {
    return nodes.find((n) => n.id === id)?.text
}

// ─── serialization ──────────────────────────────────────────────────────────

describe('document round trip is the identity (test-02)', () => {
    it('serialize → jsonCodec → parse → deserialize reproduces the document', () => {
        const a = outline.addChild('root', { text: 'First' })!
        const b = outline.addChild(a.id, { text: 'Child', description: 'with a description' })!
        outline.addChild(b.id, { text: 'Grandchild' })
        const task = outline.addChild('root', { text: 'A task' })!
        outline.toggleDone(task.id)
        outline.toggleOpen(a.id)

        const first = outline.snapshot()
        const serialized = outline.serialize()
        assertEqual(JSON.stringify(first), serialized, 'serialize() is snapshot() as JSON')

        const encoded = jsonCodec.serialize(first)
        const parsed = jsonCodec.parse(encoded)
        assertEqual(JSON.stringify(parsed), serialized, 'the codec preserves the document value')

        outline.deserialize(encoded)
        assertEqual(outline.serialize(), serialized, 'load-then-save is the identity')
        assertTreeInvariants('after round trip')
    })

    it('the identity holds for an empty document', () => {
        const first = outline.serialize()
        outline.deserialize(jsonCodec.serialize(outline.snapshot()))
        assertEqual(outline.serialize(), first)
    })
})

// ─── merge ──────────────────────────────────────────────────────────────────

describe('merge invariants (test-02)', () => {
    const baseline = 100

    it('is idempotent: merging a document with itself changes nothing and conflicts on nothing', () => {
        const original = doc(node('n1', 'one', { lastModified: 200 }), node('n2', 'two'))
        const result = mergeDocuments(original.nodes, original.nodes, baseline)
        assertEqual(result.conflicts.length, 0, 'no conflicts against itself')
        assertEqual(textOf(result.merged, 'n1'), 'one')
        assertEqual(textOf(result.merged, 'n2'), 'two')
        assertEqual(result.merged.length, original.nodes.length, 'no node is dropped')
    })

    it('picks the changed side whichever order the sides arrive in', () => {
        const edited = doc(node('n1', 'edited here', { lastModified: 200 }), node('n2', 'untouched'))
        const original = doc(node('n1', 'original', { lastModified: baseline }), node('n2', 'untouched'))

        const forward = mergeDocuments(edited.nodes, original.nodes, baseline)
        const backward = mergeDocuments(original.nodes, edited.nodes, baseline)

        assertEqual(forward.conflicts.length, 0, 'a one-sided change is not a conflict')
        assertEqual(backward.conflicts.length, 0, 'a one-sided change is not a conflict')
        assertEqual(textOf(forward.merged, 'n1'), 'edited here')
        assertEqual(textOf(backward.merged, 'n1'), 'edited here', 'the result does not depend on argument order')
        assertEqual(JSON.stringify(forward.merged), JSON.stringify(backward.merged), 'the merged documents are equal')
    })

    it('the document-level merge agrees with the node-level one', () => {
        const local = doc(node('n1', 'local', { lastModified: 200 }))
        const remote = doc(node('n1', 'remote', { lastModified: 100 }))
        const viaNodes = mergeDocuments(local.nodes, remote.nodes, baseline)
        const viaDoc = merge(local, remote, baseline)
        assertEqual(viaDoc.kind, 'merged')
        if (viaDoc.kind !== 'merged') return
        assertEqual(JSON.stringify(viaDoc.doc.nodes), JSON.stringify(viaNodes.merged))
    })
})

// ─── random operations ──────────────────────────────────────────────────────

describe('random operation sequences keep the tree valid (test-02)', () => {
    it('holds every invariant after 400 mixed operations, with round trips in between', () => {
        const random = seeded(20261113)
        const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)]

        for (let step = 0; step < 400; step += 1) {
            const ids = outline.snapshot().nodes.map((n) => n.id)
            const nonRoot = ids.filter((id) => id !== 'root')
            const target = nonRoot.length > 0 ? pick(nonRoot) : 'root'
            const action = Math.floor(random() * 9)

            switch (action) {
                case 0:
                    outline.addChild(target, { text: `node ${step}` })
                    break
                case 1:
                    outline.update(target, { text: `text ${step}` })
                    break
                case 2:
                    outline.indent(target)
                    break
                case 3:
                    outline.outdent(target)
                    break
                case 4:
                    outline.moveUp(target)
                    break
                case 5:
                    outline.moveDown(target)
                    break
                case 6:
                    outline.toggleOpen(target)
                    break
                case 7:
                    if (target !== 'root') outline.deleteNode(target)
                    break
                case 8: {
                    const before = outline.serialize()
                    outline.deserialize(jsonCodec.serialize(outline.snapshot()))
                    assertEqual(outline.serialize(), before, `step ${step}: the mid-sequence round trip is the identity`)
                    break
                }
                default:
                    break
            }

            assertTreeInvariants(`step ${step} (action ${action})`)
        }
    })

    it('deleting a node removes its whole subtree and leaves no orphans', () => {
        const parent = outline.addChild('root', { text: 'parent' })!
        const child = outline.addChild(parent.id, { text: 'child' })!
        outline.addChild(child.id, { text: 'grandchild' })
        const sibling = outline.addChild('root', { text: 'sibling' })

        outline.deleteNode(parent.id)

        const doc = outline.snapshot()
        assert(!doc.nodes.some((n) => n.id === parent.id), 'the parent is gone')
        assert(!doc.nodes.some((n) => n.id === child.id), 'the child is gone')
        assert(doc.nodes.some((n) => n.id === sibling!.id), 'the sibling stays')
        assertTreeInvariants('after subtree delete')
    })
})
