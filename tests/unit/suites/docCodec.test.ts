import { describe, it, beforeEach } from 'bun:test'
// Unit suite for the document codecs (storage seam PR 1, docs §4.6/§10).
// Covers jsonCodec (Local/Remote/Memory at-rest format) and vmdCodec
// (File/export format): round-trips, validation errors, and cross-consistency
// with the live outline so the pure codecs cannot drift from outline.ts.
import outline from '../../../source/js/outline.js'
import { jsonCodec, vmdCodec } from '../../../source/js/docCodec.js'
import type { OutlineDoc, OutlineNode } from '../../../source/js/model.js'
import { CorruptDocumentError } from '../../../source/js/outline.js'
import { UnsupportedVersionError } from '../../../source/js/crypto2.js'
import { StoreError } from '../../../source/js/storage.js'
import { assert, assertEqual } from '../testing.js'

beforeEach(() => outline.reset())

async function expectCodecError(fn: () => unknown, code: string, label: string, causeType?: Function) {
    let threw: any = null
    try { await fn() } catch (e) { threw = e }
    assert(threw instanceof StoreError, `${label}: threw StoreError (got ${threw?.constructor?.name})`)
    assertEqual(threw.code, code, `${label}: code`)
    if (causeType) assert(threw.cause instanceof causeType, `${label}: cause preserved (two-channel)`)
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function node(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
    return {
        text: 'Hello',
        children: [],
        parentId: 'root',
        open: true,
        lastModified: 0,
        ...overrides
    } as OutlineNode
}

function doc(nodes: OutlineNode[], extra: Record<string, any> = {}): OutlineDoc {
    return {
        modelVersion: 'v1',
        dataVersion: 3,
        nodes: [
            node({ id: 'root', text: '', parentId: null, children: nodes.filter(n => (n.parentId ?? 'root') === 'root').map(n => n.id) }),
            ...nodes
        ],
        ...extra
    }
}

// ─── jsonCodec ───────────────────────────────────────────────────────────────


describe('jsonCodec — round-trip', () => {

  it('serialize → parse returns an equal document', () => {
      const original = doc([
          node({ id: 'a', text: 'First', children: ['b'] }),
          node({ id: 'b', text: 'Nested', parentId: 'a', description: 'with description' })
      ])

      const text = jsonCodec.serialize(original)
      const parsed = jsonCodec.parse(text)

      assertEqual(JSON.stringify(parsed), JSON.stringify(original), 'round-trip is lossless')
  })

  it('a doc produced by outline.serialize() parses and re-serializes identically', () => {
      outline.addChild('root', { text: 'live node' })
      const atRest = outline.serialize()

      const parsed = jsonCodec.parse(atRest)
      assertEqual(jsonCodec.serialize(parsed), atRest, 'codec round-trips the at-rest format byte-for-byte')
  })
})

describe('jsonCodec — validation', () => {

  it('invalid JSON throws invalid-document', () => {
      expectCodecError(() => jsonCodec.parse('{ not json'), 'invalid-document', 'bad JSON', CorruptDocumentError)
  })

  it('non-object top level throws invalid-document', () => {
      for (const bad of ['[]', '"str"', 'null', '42']) {
          expectCodecError(() => jsonCodec.parse(bad), 'invalid-document', `top level ${bad}`, CorruptDocumentError)
      }
  })

  it('missing model version throws invalid-document', () => {
      expectCodecError(() => jsonCodec.parse('{"nodes":[]}'), 'invalid-document', 'no model version', CorruptDocumentError)
  })

  it('a future model version throws unsupported-runtime', () => {
      expectCodecError(() => jsonCodec.parse('{"modelVersion":"v2","nodes":[]}'), 'unsupported-runtime', 'future version', UnsupportedVersionError)
  })

  it('a missing node list throws invalid-document', () => {
      expectCodecError(() => jsonCodec.parse('{"modelVersion":"v1"}'), 'invalid-document', 'no nodes', CorruptDocumentError)
  })

  it('invalid node entries throw invalid-document', () => {
      for (const bad of [
          '{"modelVersion":"v1","nodes":[{}]}',
          '{"modelVersion":"v1","nodes":[{"id":1}]}',
          '{"modelVersion":"v1","nodes":["not an object"]]}',
          '{"modelVersion":"v1","nodes":[{"id":"a","children":"nope"}]}'
      ]) {
          expectCodecError(() => jsonCodec.parse(bad), 'invalid-document', 'node entry', CorruptDocumentError)
      }
  })

  it('a missing root node throws invalid-document', () => {
      expectCodecError(() => jsonCodec.parse('{"modelVersion":"v1","nodes":[{"id":"a","parentId":"root"}]}'), 'invalid-document', 'no root', CorruptDocumentError)
  })

  // ─── vmdCodec — writer ───────────────────────────────────────────────────────
})

describe('vmdCodec — serialize', () => {

  it('renders nodes, nesting and descriptions with outline.getVMD semantics', () => {
      const text = vmdCodec.serialize(doc([
          node({ id: 'a', text: 'First', children: ['b'], description: 'line one\nline two' }),
          node({ id: 'b', text: 'Nested', parentId: 'a' })
      ]))

      // level-0 node: no indent, description at 2 spaces; child at 2 spaces
      assertEqual(text, '- First\n  line one\n  line two\n  - Nested\n', 'exact VMD output')
  })

  it('a parent with children renders + when collapsed, - when open', () => {
      const open = vmdCodec.serialize(doc([
          node({ id: 'a', text: 'A', children: ['b'], open: true }),
          node({ id: 'b', text: 'B', parentId: 'a' })
      ]))
      const collapsed = vmdCodec.serialize(doc([
          node({ id: 'a', text: 'A', children: ['b'], open: false }),
          node({ id: 'b', text: 'B', parentId: 'a' })
      ]))
      const childless = vmdCodec.serialize(doc([node({ id: 'a', text: 'A', open: false })]))

      assertEqual(open, '- A\n  - B\n', 'open parent uses -')
      assertEqual(collapsed, '+ A\n  - B\n', 'collapsed parent uses + (children still render)')
      assertEqual(childless, '- A\n', 'childless node always uses -')
  })

  it('tasks render their checkbox prefix', () => {
      const text = vmdCodec.serialize(doc([
          node({ id: 'a', text: 'todo', done: false }),
          node({ id: 'b', text: 'done', done: true })
      ]))

      assertEqual(text, '- [ ] todo\n- [x] done\n', 'checkbox prefixes')
  })

  it('undefined open is treated as open, matching outline.serialize() omission', () => {
      const text = vmdCodec.serialize(doc([
          node({ id: 'a', text: 'A', children: ['b'], open: undefined }),
          node({ id: 'b', text: 'B', parentId: 'a' })
      ]))
      assertEqual(text, '- A\n  - B\n', 'undefined open → open')
  })

  // ─── vmdCodec — parser ────────────────────────────────────────────────────────
})

describe('vmdCodec — parse', () => {

  it('parses nesting, bullets and descriptions into a node tree', () => {
      const parsed = vmdCodec.parse('- First\n  line one\n  line two\n  - Nested\n')

      assertEqual(parsed.nodes.length, 3, 'root + two nodes')
      const first = parsed.nodes.find(n => n.id === 'v_root_0')!
      const nested = parsed.nodes.find(n => n.id === 'v_root_0_0')!
      assertEqual(first.text, 'First', 'first node text')
      assertEqual(first.description, 'line one\nline two', 'multi-line description joined')
      assertEqual(JSON.stringify(first.children), JSON.stringify(['v_root_0_0']), 'positional child id')
      assertEqual(nested.parentId, 'v_root_0', 'nested parent id')
      assertEqual(parsed.nodes[0].id, 'root', 'root present')
  })

  it('checkbox prefixes become done states, + means collapsed', () => {
      const parsed = vmdCodec.parse('- [ ] todo\n- [x] done\n+ Collapsed\n')

      const todo = parsed.nodes.find(n => n.text === 'todo')!
      const done = parsed.nodes.find(n => n.text === 'done')!
      const collapsed = parsed.nodes.find(n => n.text === 'Collapsed')!
      assertEqual(todo.done, false, 'unchecked task')
      assertEqual(done.done, true, 'checked task')
      assertEqual(collapsed.open, false, '+ bullet → collapsed')
      assertEqual(todo.open, true, '- bullet → open')
  })

  it('blank lines are skipped and CRLF input is accepted', () => {
      const parsed = vmdCodec.parse('- A\r\n\r\n  - B\r\n')
      assertEqual(parsed.nodes.length, 3, 'root + two nodes')
  })

  it('description escape prefixes are stripped', () => {
      const parsed = vmdCodec.parse('- A\n  \\- looks like a bullet\n  \\+ also\n  \\\\ double backslash\n')

      const a = parsed.nodes.find(n => n.text === 'A')!
      assertEqual(a.description, '- looks like a bullet\n+ also\n\\ double backslash', 'escapes stripped, lines joined')
  })

  it('a description line before any node bullet throws invalid-document', () => {
      expectCodecError(() => vmdCodec.parse('just a description'), 'invalid-document', 'stray description', CorruptDocumentError)
  })

  it('round-trip: parse(serialize(doc)) reproduces the tree', () => {
      const original = doc([
          node({ id: 'a', text: 'First', children: ['b'], description: 'desc' }),
          node({ id: 'b', text: 'Nested', parentId: 'a', done: true })
      ])

      const parsed = vmdCodec.parse(vmdCodec.serialize(original))

      assertEqual(parsed.nodes.length, 3, 'same node count')
      // VMD carries no ids, so compare by structure: the root child and its child
      const a = parsed.nodes.find(n => n.parentId === 'root')!
      const b = parsed.nodes.find(n => n.parentId === a.id)!
      assertEqual(a.text, 'First', 'text preserved')
      assertEqual(a.description, 'desc', 'description preserved')
      assertEqual(b.text, 'Nested', 'child text preserved')
      assertEqual(b.done, true, 'done preserved')
      assertEqual(JSON.stringify(a.children), JSON.stringify([b.id]), 'children list preserved')
  })

  it('a description holding a markdown list survives the round-trip', () => {
      // VMD.md §4.1: the writer escapes description lines that would re-parse
      // as items. Without the escape, '- item one' became a child node and the
      // description text was lost on reload.
      const original = doc([
          node({ id: 'a', text: 'Notes', description: '- item one\nplain\n+ other' })
      ])

      const vmd = vmdCodec.serialize(original)
      assert(vmd.includes('\\- item one'), `the item-looking line is escaped: ${JSON.stringify(vmd)}`)
      assert(vmd.includes('\\+ other'), `the plus-looking line is escaped: ${JSON.stringify(vmd)}`)

      const parsed = vmdCodec.parse(vmd)
      const a = parsed.nodes.find(n => n.parentId === 'root')!
      assertEqual(a.description, '- item one\nplain\n+ other', 'description content preserved')
      assertEqual(parsed.nodes.length, 2, 'no child node was created from the list')
  })

  it('a description starting with a backslash survives the round-trip', () => {
      const original = doc([
          node({ id: 'a', text: 'Notes', description: '\\- literal' })
      ])
      const parsed = vmdCodec.parse(vmdCodec.serialize(original))
      const a = parsed.nodes.find(n => n.parentId === 'root')!
      assertEqual(a.description, '\\- literal', 'the backslash is not doubled per round-trip')
  })

  it('an item marker without a space is description text, not a node', () => {
      const parsed = vmdCodec.parse('- real item\n  -not a bullet')
      const items = parsed.nodes.filter(n => n.parentId === 'root')
      assertEqual(items.length, 1, 'only the spaced marker makes a node')
      assertEqual(items[0].description, '-not a bullet', 'the unspaced marker stays description text')
  })

  // ─── cross-consistency with the live outline ────────────────────────────────
})

describe('vmdCodec — cross-consistency with outline.ts', () => {

  it('parse() produces the same node tree as outline.setRootVMD()', () => {
      const text = '- First\n  some description\n  - [x] Nested done\n- Second\n'

      outline.setRootVMD(text)
      const live = JSON.parse(outline.serialize())
      outline.reset()

      const parsed = vmdCodec.parse(text)

      assertEqual(parsed.nodes.length, live.nodes.length, 'same node count')
      const byId = new Map<string, OutlineNode>(live.nodes.map((n: OutlineNode) => [n.id, n] as [string, OutlineNode]))
      for (const node of parsed.nodes) {
          const liveNode = byId.get(node.id)
          if (!liveNode) throw new Error(`live outline has no node ${node.id}`)
          assertEqual(liveNode.text || '', node.text || '', `text matches for ${node.id}`)
          assertEqual(liveNode.description || '', node.description || '', `description matches for ${node.id}`)
          assertEqual(JSON.stringify(liveNode.children || []), JSON.stringify(node.children || []), `children match for ${node.id}`)
          assertEqual(liveNode.done ?? null, node.done ?? null, `done matches for ${node.id}`)
          assertEqual(liveNode.open === undefined ? true : liveNode.open, node.open === undefined ? true : node.open, `open matches for ${node.id}`)
      }
  })

  it('serialize() produces the same text as outline.getVMD("root")', () => {
      const first = outline.addChild('root', { text: 'First', description: 'some description' })
      outline.addChild('root', { text: 'Second' })
      outline.addChild(first!.id, { text: 'Nested done', done: true })

      const liveText = outline.getVMD('root')
      const codecText = vmdCodec.serialize(JSON.parse(outline.serialize()))

      assertEqual(codecText, liveText, 'codec writer matches outline.getVMD')
  })
})