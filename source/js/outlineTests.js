import outline from "./outline.js"
import {
  assert,
  assertEqual,
  cloneSections,
  createAsyncSectionHarness,
  streamCompletedSections,
  summaryFromSections
} from './testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

const harness = createAsyncSectionHarness({ beforeEach: () => outline.reset() })
export const sections = harness.sections
const section = harness.section
const test = harness.test

function assertChildren(nodeId, expectedIds) {
  const node = outline.get(nodeId)
  assert(node !== undefined, `Node ${nodeId} should exist`)
  assertEqual(
    JSON.stringify(node.children.peek()),
    JSON.stringify(expectedIds),
    `Children of "${nodeId}"`
  )
}

export function summary() {
  return summaryFromSections(sections)
}

// Outline tests execute at module load time. This helper streams those completed
// results incrementally so the UI can render progress in a reactive way.
export async function streamOutlineTests(onProgress) {
  return streamCompletedSections(cloneSections(sections), onProgress, 10)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// root → [A, B, C],  B → [D, E]
function buildTree() {
  outline.addChild('root', { id: 'A', text: 'A' })
  outline.addChild('root', { id: 'B', text: 'B' })
  outline.addChild('root', { id: 'C', text: 'C' })
  outline.addChild('B', { id: 'D', text: 'D' })
  outline.addChild('B', { id: 'E', text: 'E' })
}

// ─── tests ────────────────────────────────────────────────────────────────────

section("Root node")

await test("getRoot() and get('root') return the same instance", () => {
  assert(outline.getRoot() === outline.get('root'), "Should be same reference")
})

await test("Root node has id 'root'", () => {
  assertEqual(outline.getRoot().id, 'root', "Root id")
})

await test("Root node starts with no children", () => {
  assertChildren('root', [])
})

await test("peek() returns a plain object, not the node itself", () => {
  const root = outline.getRoot()
  const peeked = root.peek()
  assert(peeked !== root, "peek() should return a new object")
  assert(typeof peeked === 'object', "peek() should return an object")
  assertEqual(peeked.id, 'root', "peek().id should be 'root'")
})

await test("Two peek() calls return distinct objects", () => {
  const root = outline.getRoot()
  assert(root.peek() !== root.peek(), "Each peek() call should produce a new object")
})

await test("Cannot delete root node", () => {
  outline.deleteNode('root')
  assert(outline.getRoot() !== undefined, "Root should still exist after attempted delete")
})


section("Adding nodes")

await test("addChild returns the created node", () => {
  const node = outline.addChild('root')
  assert(node !== undefined, "Should return a node")
  assert(node.id !== undefined, "Node should have an id")
})

await test("New node has correct parentId", () => {
  const node = outline.addChild('root')
  assertEqual(node.parentId, 'root', "parentId should be 'root'")
})

await test("New node appears in parent's children", () => {
  const node = outline.addChild('root')
  assert(outline.getRoot().children.peek().includes(node.id), "Root children should include new node")
})

await test("addChild with explicit id, text, description, open", () => {
  const node = outline.addChild('root', { id: 'X', text: 'hello', description: 'desc', open: false })
  assertEqual(node.id, 'X', "id")
  assertEqual(node.text.peek(), 'hello', "text")
  assertEqual(node.description.peek(), 'desc', "description")
  assertEqual(node.open.peek(), false, "open")
})

await test("addChild to non-root parent", () => {
  const parent = outline.addChild('root', { id: 'P' })
  const child = outline.addChild('P', { id: 'CH' })
  assertEqual(child.parentId, 'P', "Child parentId should be 'P'")
  assertChildren('P', ['CH'])
})

await test("Multiple children added in order", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'B' })
  outline.addChild('root', { id: 'C' })
  assertChildren('root', ['A', 'B', 'C'])
})

section("Deleting nodes")

await test("deleteNode removes node from map", () => {
  buildTree()
  outline.deleteNode('A')
  assert(outline.get('A') === undefined, "Node A should be gone")
})

await test("deleteNode removes node from parent's children", () => {
  buildTree()
  outline.deleteNode('A')
  assert(!outline.getRoot().children.peek().includes('A'), "Root should not include A")
})

await test("deleteNode recursively removes descendants", () => {
  buildTree()
  outline.deleteNode('B')
  assert(outline.get('B') === undefined, "B should be gone")
  assert(outline.get('D') === undefined, "D (child of B) should be gone")
  assert(outline.get('E') === undefined, "E (child of B) should be gone")
})

await test("deleteNode does not affect siblings", () => {
  buildTree()
  outline.deleteNode('B')
  assert(outline.get('A') !== undefined, "A should still exist")
  assert(outline.get('C') !== undefined, "C should still exist")
  assertChildren('root', ['A', 'C'])
})

await test("Deleting a non-existent node is a no-op", () => {
  buildTree()
  outline.deleteNode('nonexistent')
  // no error thrown
})


section("Updating nodes")

await test("updateNode changes text", () => {
  buildTree()
  outline.updateNode('A', { text: 'updated' })
  assertEqual(outline.get('A').text.peek(), 'updated', "Text should be updated")
})

await test("updateNode changes description", () => {
  buildTree()
  outline.updateNode('A', { description: 'a desc' })
  assertEqual(outline.get('A').description.peek(), 'a desc', "Description should be updated")
})

await test("updateNode with only text leaves description unchanged", () => {
  outline.addChild('root', { id: 'A', description: 'keep me' })
  outline.updateNode('A', { text: 'new text' })
  assertEqual(outline.get('A').description.peek(), 'keep me', "Description should be unchanged")
})

await test("updateNode with only description leaves text unchanged", () => {
  outline.addChild('root', { id: 'A', text: 'keep me' })
  outline.updateNode('A', { description: 'new desc' })
  assertEqual(outline.get('A').text.peek(), 'keep me', "Text should be unchanged")
})


section("toggleOpen")

await test("toggleOpen flips open from true to false", () => {
  outline.addChild('root', { id: 'A', open: true })
  outline.toggleOpen('A')
  assertEqual(outline.get('A').open.peek(), false, "Should be false after toggle")
})

await test("toggleOpen flips open from false to true", () => {
  outline.addChild('root', { id: 'A', open: false })
  outline.toggleOpen('A')
  assertEqual(outline.get('A').open.peek(), true, "Should be true after toggle")
})

await test("toggleOpen twice restores original value", () => {
  outline.addChild('root', { id: 'A', open: true })
  outline.toggleOpen('A')
  outline.toggleOpen('A')
  assertEqual(outline.get('A').open.peek(), true, "Should be back to true")
})


section("moveUp / moveDown")

await test("moveUp swaps node with previous sibling", () => {
  buildTree()
  outline.moveUp('B')
  assertChildren('root', ['B', 'A', 'C'])
})

await test("moveUp of first sibling moves node before parent in grandparent", () => {
  buildTree()
  // D is the first child of B; B is at index 1 in root → [A, B, C]
  outline.moveUp('D')
  // D should now be in root before B: [A, D, B, C], B's children: [E]
  assertChildren('root', ['A', 'D', 'B', 'C'])
  assertChildren('B', ['E'])
  assertEqual(outline.get('D').parentId, 'root', "D should be re-parented to root")
})

await test("moveUp of first root child is a no-op", () => {
  buildTree()
  outline.moveUp('A') // A is first child of root, root has no parent
  assertChildren('root', ['A', 'B', 'C'])
})

await test("moveDown swaps node with next sibling", () => {
  buildTree()
  outline.moveDown('B')
  assertChildren('root', ['A', 'C', 'B'])
})

await test("moveDown of last sibling moves node after parent in grandparent", () => {
  buildTree()
  // E is the last child of B; B is at index 1 in root → [A, B, C]
  outline.moveDown('E')
  // E should now be in root after B: [A, B, E, C], B's children: [D]
  assertChildren('root', ['A', 'B', 'E', 'C'])
  assertChildren('B', ['D'])
  assertEqual(outline.get('E').parentId, 'root', "E should be re-parented to root")
})

await test("moveDown of last root child is a no-op", () => {
  buildTree()
  outline.moveDown('C') // C is last child of root, root has no parent
  assertChildren('root', ['A', 'B', 'C'])
})


section("indent / outdent")

await test("indent makes node a child of its previous sibling", () => {
  buildTree()
  // indent C → C becomes last child of B
  outline.indent('C')
  assertChildren('root', ['A', 'B'])
  assertChildren('B', ['D', 'E', 'C'])
  assertEqual(outline.get('C').parentId, 'B', "C should be re-parented to B")
})

await test("indent first child is a no-op", () => {
  buildTree()
  outline.indent('A') // A has no previous sibling
  assertChildren('root', ['A', 'B', 'C'])
  assertEqual(outline.get('A').parentId, 'root', "A's parent should be unchanged")
})

await test("outdent moves node to grandparent after its parent", () => {
  buildTree()
  // D is child of B, B is at index 1 in root → [A, B, C]
  outline.outdent('D')
  assertChildren('root', ['A', 'B', 'D', 'C'])
  assertEqual(outline.get('D').parentId, 'root', "D should be re-parented to root")
  assertChildren('D', ['E'])
})

await test("outdent second child also positions correctly", () => {
  buildTree()
  outline.outdent('E')
  assertChildren('root', ['A', 'B', 'E', 'C'])
  assertChildren('B', ['D'])
})

await test("outdent root child is a no-op", () => {
  buildTree()
  outline.outdent('A') // A's parent is root, root has no parent
  assertChildren('root', ['A', 'B', 'C'])
  assertEqual(outline.get('A').parentId, 'root', "A's parent should be unchanged")
})


section("Serialize")

await test("serialize produces valid JSON", () => {
  buildTree()
  const json = outline.serialize()
  const parsed = JSON.parse(json) // throws on invalid JSON
  assert(parsed !== null, "Parsed result should not be null")
})

await test("serialized output contains modelVersion, dataVersion, nodes", () => {
  buildTree()
  const parsed = JSON.parse(outline.serialize())
  assert('modelVersion' in parsed, "Should have modelVersion")
  assert('dataVersion' in parsed, "Should have dataVersion")
  assert('nodes' in parsed, "Should have nodes")
})

await test("serialize pretty produces indented output", () => {
  outline.addChild('root', { id: 'A' })
  const pretty = outline.serialize(true)
  assert(pretty.includes('\n'), "Pretty JSON should have newlines")
  assert(pretty.includes('  '), "Pretty JSON should have indentation")
})

await test("serialize includes all nodes", () => {
  buildTree()
  const parsed = JSON.parse(outline.serialize())
  const ids = parsed.nodes.map(n => n.id);
  ['root', 'A', 'B', 'C', 'D', 'E'].forEach(id => {
    assert(ids.includes(id), `Serialized output should include node ${id}`)
  })
})

await test("root node serialized with null parentId", () => {
  const parsed = JSON.parse(outline.serialize())
  assert(!parsed.nodes.find(n => n.id === 'root').parentId, "Root parentId should be null or undefined in serialized output")
})

await test("serialize round-trip preserves open state", () => {
  outline.addChild('root', { id: 'A', open: false })
  outline.addChild('root', { id: 'B', open: true })
  const parsed = JSON.parse(outline.serialize())
  assertEqual(parsed.nodes.find(n => n.id === 'A').open, false, "Node A open should be false")
  assertEqual(parsed.nodes.find(n => n.id === 'B').open, undefined, "Node B open should be undefined (true is default)")
})


section("Deserialize")

const fixture = JSON.stringify({
  modelVersion: 'v1',
  dataVersion: 10,
  nodes: [
    { id: 'root', parentId: null, text: '', description: '', children: ['A', 'B'], open: true },
    { id: 'A', parentId: 'root', text: 'Alpha', description: 'desc A', children: [], open: false },
    { id: 'B', parentId: 'root', text: 'Beta', description: '', children: ['C'], open: true },
    { id: 'C', parentId: 'B', text: 'Gamma', description: '', children: [], open: true }
  ]
})

await test("Deserialize restores nodes", () => {
  outline.deserialize(fixture)
  assert(outline.get('A') !== undefined, "A should exist")
  assert(outline.get('B') !== undefined, "B should exist")
  assert(outline.get('C') !== undefined, "C should exist")
})

await test("Deserialize restores text and description", () => {
  outline.deserialize(fixture)
  assertEqual(outline.get('A').text.peek(), 'Alpha', "A text")
  assertEqual(outline.get('A').description.peek(), 'desc A', "A description")
})

await test("Deserialize restores open state", () => {
  outline.deserialize(fixture)
  assertEqual(outline.get('A').open.peek(), false, "A open")
  assertEqual(outline.get('B').open.peek(), true, "B open")
})

await test("Deserialize restores parent-child relationships", () => {
  outline.deserialize(fixture)
  assertChildren('root', ['A', 'B'])
  assertChildren('B', ['C'])
  assertEqual(outline.get('C').parentId, 'B', "C parentId")
})

outline.dirtyDebounceTimeout = 10 // speed up tests that check dirty state after deserialize
async function checkVersion(version, fn) {
  fn()
  assert(outline.isDirty, "Outline should be dirty after change")
  // wait for debounced version update
  await new Promise(resolve => setTimeout(resolve, 20))
  assert(!outline.isDirty, "Outline should not be dirty after version update")
  assertEqual(outline.version.peek(), version, `Version should be ${version}`)
}

await test("Deserialize restores dataVersion", async () => {
  outline.deserialize(fixture)
  assert(!outline.isDirty, "Outline should not be dirty after deserialize")
  // wait for debounced version update
  await new Promise(resolve => setTimeout(resolve, 20))
  assert(!outline.isDirty, "Outline should not be dirty after deserialize")
  assertEqual(outline.version.peek(), 10, `Version should be 10`)
})

await test("Deserialize throws on wrong modelVersion", () => {
  let threw = false
  try {
    outline.deserialize(JSON.stringify({ modelVersion: 'v99', nodes: { root: {} } }))
  } catch (e) {
    threw = true
  }
  assert(threw, "Should throw on unknown modelVersion")
})

await test("Deserialize throws on missing root node", () => {
  let threw = false
  try {
    outline.deserialize(JSON.stringify({ modelVersion: 'v1', nodes: { X: {} } }))
  } catch (e) {
    threw = true
  }
  assert(threw, "Should throw when root node is absent")
})

await test("Deserialize skips node with invalid parentId", () => {
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: [
      { id: 'root', parentId: null, text: '', description: '', children: [], open: true },
      { id: 'orphan', parentId: 'nonexistent', text: 'orphan', description: '', children: [], open: true }
    ]
  })
  outline.deserialize(data)
  assert(outline.get('orphan') === undefined, "Orphan node should be skipped")
})

await test("Deserialize skips child whose parentId does not match", () => {
  // B claims to have child C, but C's parentId is 'root', not 'B'
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: [
      { id: 'root', parentId: null, text: '', description: '', children: ['B'], open: true },
      { id: 'B', parentId: 'root', text: 'B', description: '', children: ['C'], open: true },
      { id: 'C', parentId: 'root', text: 'C', description: '', children: [], open: true }
    ]
  })
  outline.deserialize(data)
  assertChildren('B', [])
})

await test("Deserialize deduplicates repeated child references", () => {
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: [
      { id: 'root', parentId: null, text: '', description: '', children: ['A', 'A'], open: true },
      { id: 'A', parentId: 'root', text: 'A', description: '', children: [], open: true }
    ]
  })
  outline.deserialize(data)
  assertChildren('root', ['A'])
})

await test("Deserialize skips self-referential child", () => {
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: [
      { id: 'root', parentId: null, text: '', description: '', children: ['A'], open: true },
      { id: 'A', parentId: 'root', text: 'A', description: '', children: ['A'], open: true }
    ]
  })
  outline.deserialize(data)
  assertChildren('A', [])
})

await test("Full serialize → deserialize round-trip", () => {
  buildTree()
  outline.updateNode('A', { text: 'Alfa', description: 'first' })
  outline.toggleOpen('B')
  const json = outline.serialize()
  outline.reset()
  outline.deserialize(json)
  assertEqual(outline.get('A').text.peek(), 'Alfa', "A text after round-trip")
  assertEqual(outline.get('A').description.peek(), 'first', "A description after round-trip")
  assertEqual(outline.get('B').open.peek(), false, "B open after round-trip")
  assertChildren('root', ['A', 'B', 'C'])
  assertChildren('B', ['D', 'E'])
})


section("dataVersion tracking")

await test("Starts at 0 after reset", () => {
  assertEqual(outline.version.peek(), 0, "version should be 0")
})

await test("addChild increments version", async () =>
  await checkVersion(1, () => outline.addChild('root')))

await test("deleteNode increments version", async () => {
  outline.addChild('root', { id: 'A' })
  const v = outline.version.peek()
  await checkVersion(v + 1, () => {
    outline.deleteNode('A')
    assert(outline.isDirty, "Outline should be dirty after deleteNode")
  })
})

await test("updateNode increments version", async () => {
  outline.addChild('root', { id: 'A' })
  const v = outline.version.peek()
  await checkVersion(v + 1, () => outline.updateNode('A', { text: 'x' }))
})

await test("toggleOpen increments version", async () => {
  outline.addChild('root', { id: 'A' })
  const v = outline.version.peek()
  await checkVersion(v + 1, () => outline.toggleOpen('A'))
})

await test("moveUp increments version", async () => {
  buildTree()
  const v = outline.version.peek()
  await checkVersion(v + 1, () => outline.moveUp('B'))
})

await test("indent increments version", async () => {
  buildTree()
  const v = outline.version.peek()
  await checkVersion(v + 1, () => outline.indent('C'))
})


section("getVMD")

await test("Flat list", () => {
  outline.addChild('root', { id: 'A', text: 'Alpha' })
  outline.addChild('root', { id: 'B', text: 'Beta' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- Alpha\n- Beta\n", "Flat VMD")
})

await test("Nested list", () => {
  outline.addChild('root', { id: 'A', text: 'A' })
  outline.addChild('A', { id: 'B', text: 'B' })
  outline.addChild('A', { id: 'C', text: 'C' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- A\n  - B\n  - C\n", "Nested VMD")
})

await test("Collapsed node with children uses + bullet", () => {
  outline.addChild('root', { id: 'A', text: 'A', open: false })
  outline.addChild('A', { id: 'B', text: 'B' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "+ A\n  - B\n", "Collapsed parent should use +")
})

await test("Leaf node with open:false still uses - bullet", () => {
  outline.addChild('root', { id: 'A', text: 'A', open: false })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- A\n", "Leaf open:false should still use -")
})

await test("Description lines are indented under their node", () => {
  outline.addChild('root', { id: 'A', text: 'A', description: 'line one\nline two' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- A\n  line one\n  line two\n", "Description should be indented")
})

await test("getVMD for a specific subtree", () => {
  buildTree()
  outline.updateNode('D', { text: 'D-text' })
  outline.updateNode('E', { text: 'E-text' })
  const vmd = outline.getVMD('B')
  assertEqual(vmd, "- B\n  - D-text\n  - E-text\n", "Subtree VMD should start from given node")
})


section("setVMD")

await test("Basic parsing creates child nodes", () => {
  const parent = outline.addChild('root', { id: 'P', text: 'P' })
  outline.setVMD("- X\n- Y\n", 'P')
  const children = outline.getRoot().children.peek()
  assertEqual(children.length, 2, "Should have 2 children")
  assertEqual(outline.get(children[0]).id, 'P', "First child should keep ID")
  assertEqual(outline.get(children[0]).text.peek(), 'X', "First child text")
  assertEqual(outline.get(children[1]).text.peek(), 'Y', "Second child text")
})

await test("+ bullet sets open to false", () => {
  const parent = outline.addChild('root', { id: 'P' })
  outline.addChild('P', { id: 'DUMMY' }) // child so + renders
  outline.setVMD("+ Closed\n  - child\n", 'P')
  const ch = outline.get('P').children.peek()
  // The first bullet updates P itself (open state)
  assertEqual(outline.get('P').open.peek(), false, "P should be closed after + bullet (regression: bug #4)")
})

await test("- bullet sets open to true", () => {
  const parent = outline.addChild('root', { id: 'P', open: false })
  outline.setVMD("- Open\n", 'P')
  assertEqual(outline.get('P').open.peek(), true, "P should be open after - bullet")
})

await test("Description lines are attached to the preceding node", () => {
  outline.addChild('root', { id: 'P' })
  outline.setVMD("- A\n  some description\n", 'P')
  const pastedNode = outline.get('P').peek()
  assertEqual(pastedNode.description, 'some description', "Description should be attached")
})

await test("Multi-line description is joined with newline", () => {
  outline.addChild('root', { id: 'P' })
  outline.setVMD("- A\n  line one\n    line two\n", 'P')
  const pastedNode = outline.get('P').peek()
  assertEqual(pastedNode.description, 'line one\nline two', "Multi-line description")
})

await test("Escaped description lines starting with backtick-dash are unescaped", () => {
  const base = outline.addChild('root')
  outline.setVMD("- A\n  `- not a bullet\n", base.id)
  const pastedNode = outline.get(base.id).peek()
  assertEqual(pastedNode.description, '- not a bullet', "Escaped description line")
})

await test("Escaped description lines starting with backtick-plus are unescaped", () => {
  outline.addChild('root', { id: 'P' })
  outline.setVMD("- A\n  `+ not a bullet\n", 'P')
  const pastedNode = outline.get('P').peek()
  assertEqual(pastedNode.description, '+ not a bullet', "Escaped + description line")
})

await test("setVMD deletes existing children before parsing", () => {
  const base = outline.addChild('root')
  outline.addChild(base.id, { id: 'OLD' })
  outline.setVMD("- New", base.id)
  assert(outline.get('OLD') === undefined, "Old child should be deleted")
  const ch = outline.get(base.id).children.peek()
  assertEqual(ch.length, 0, "Should have exactly 1 new child")
  const newVmd = outline.getVMD()
  assertEqual(newVmd, "- New\n", "New VMD should match input")
})

await test("setVMD handles nested bullet structure", () => {
  const base = outline.addChild('root')
  outline.setVMD("- A\n  - B\n  - C\n- D\n", base.id)
  const ch = outline.getRoot().children.peek()
  assertEqual(ch.length, 2, "root should have 2 children")
  const A = outline.get(ch[0])
  assertChildren(A.id, [outline.get(A.children.peek()[0]).id, outline.get(A.children.peek()[1]).id])
  assertEqual(A.text.peek(), 'A', "A text")
})

await test("setVMD on root is a no-op", () => {
  const versionBefore = outline.version.peek()
  outline.setVMD("- Should not appear\n", 'root')
  assertEqual(outline.version.peek(), versionBefore, "version should not change")
  assertChildren('root', [])
})

await test("setVMD on non-existent nodeId is a no-op", () => {
  outline.setVMD("- X\n", 'nonexistent')
  assertChildren('root', [])
})

await test("VMD getVMD → setVMD round-trip", () => {
  buildTree()
  outline.updateNode('A', { text: 'Alfa', description: 'first node' })
  outline.updateNode('D', { text: 'Delta' })
  outline.updateNode('E', { text: 'Echo' })
  const originalVmd = outline.getVMD()

  // Re-apply VMD to a fresh node and compare
  outline.reset()
  const fresh = outline.addChild('root')
  outline.setVMD(originalVmd, fresh.id)
  const rebuiltVmd = outline.getVMD()
  assertEqual(rebuiltVmd, originalVmd, "Round-trip VMD should be identical")
})

// ─── addChild positioning ────────────────────────────────────────────────────

section("addChild positioning")

await test("addChild appends in order when no previousSiblingId given", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'B' })
  outline.addChild('root', { id: 'C' })
  assertChildren('root', ['A', 'B', 'C'])
})

await test("addChild inserts immediately after previousSiblingId", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'C' })
  outline.addChild('root', { id: 'B' }, 'A')
  assertChildren('root', ['A', 'B', 'C'])
})

await test("addChild with previousSiblingId inserts at end when sibling is last", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'B' })
  outline.addChild('root', { id: 'C' }, 'B')
  assertChildren('root', ['A', 'B', 'C'])
})

await test("addChild with invalid parentId returns undefined and does not modify the tree", () => {
  const result = outline.addChild('nonexistent', { id: 'X' })
  assert(result === undefined, "Should return undefined for unknown parent")
  assert(outline.get('X') === undefined, "Node should not have been created")
  assertChildren('root', [])
})

await test("addChild with duplicate id is rejected and returns undefined", () => {
  outline.addChild('root', { id: 'A' })
  const result = outline.addChild('root', { id: 'A' })
  assert(result === undefined, "Duplicate id should return undefined")
  assertChildren('root', ['A'])
})


// ─── deleteNode edge cases ───────────────────────────────────────────────────

section("deleteNode edge cases")

await test("deleteNode clears text instead of removing the only child of the zoom root", () => {
  outline.addChild('root', { id: 'A', text: 'keep structure' })
  outline.deleteNode('A')
  assert(outline.get('A') !== undefined, "Only child should survive deletion")
  assertEqual(outline.get('A').text.peek(), '', "Text should be cleared to empty string")
  assertChildren('root', ['A'])
})

await test("deleteNode can remove a non-only child even when parent is zoom root", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'B' })
  outline.deleteNode('A')
  assert(outline.get('A') === undefined, "A should be removed when B is still present")
  assertChildren('root', ['B'])
})

await test("deleteNode cannot delete the currently zoomed node", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('A', { id: 'B' })
  outline.zoomIn('A')
  outline.deleteNode('A')
  assert(outline.get('A') !== undefined, "Zoomed node cannot be deleted")
})


// ─── indent / outdent (extended) ────────────────────────────────────────────

section("indent / outdent (extended)")

await test("indent opens the new parent if it was closed", () => {
  outline.addChild('root', { id: 'A', open: false })
  outline.addChild('root', { id: 'B' })
  outline.indent('B')
  assertEqual(outline.get('A').open.peek(), true, "A should be opened when B is indented into it")
  assertEqual(outline.get('B').parentId, 'A', "B should be re-parented to A")
})

await test("outdent carries all subsequent siblings as children of the outdented node", () => {
  // root → [A, B], B → [D, E, F]
  // outdenting D should pull E and F along with it: root → [A, B, D], D → [E, F], B → []
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'B' })
  outline.addChild('B', { id: 'D' })
  outline.addChild('B', { id: 'E' })
  outline.addChild('B', { id: 'F' })
  outline.outdent('D')
  assertChildren('root', ['A', 'B', 'D'])
  assertChildren('B', [])
  assertChildren('D', ['E', 'F'])
  assertEqual(outline.get('E').parentId, 'D', "E should be re-parented to D")
  assertEqual(outline.get('F').parentId, 'D', "F should be re-parented to D")
})

await test("outdent of last child carries no siblings (no siblings after it)", () => {
  buildTree()
  // E is the last child of B, so no siblings follow it
  outline.outdent('E')
  assertChildren('root', ['A', 'B', 'E', 'C'])
  assertChildren('B', ['D'])
  assertChildren('E', [])
})

await test("outdent opens the outdented node when siblings are moved into it", () => {
  outline.addChild('root', { id: 'B' })
  outline.addChild('B', { id: 'D', open: false })
  outline.addChild('B', { id: 'E' })
  outline.outdent('D')
  assertEqual(outline.get('D').open.peek(), true, "D should be opened to show its newly adopted children")
  assertChildren('D', ['E'])
})


// ─── reset ───────────────────────────────────────────────────────────────────

section("reset")

await test("reset removes all non-root nodes", () => {
  buildTree()
  outline.reset()
  assert(outline.get('A') === undefined, "A should not exist after reset")
  assert(outline.get('B') === undefined, "B should not exist after reset")
  assert(outline.get('D') === undefined, "D should not exist after reset")
})

await test("reset preserves the root node", () => {
  buildTree()
  outline.reset()
  assert(outline.get('root') !== undefined, "Root should still exist after reset")
  assertChildren('root', [])
})

await test("reset sets version to 0", async () => {
  buildTree()
  await new Promise(r => setTimeout(r, 50)) // let version bump settle
  outline.reset()
  assertEqual(outline.version.peek(), 0, "version should be 0 after reset")
})

await test("reset resets zoom to root", () => {
  outline.addChild('root', { id: 'A' })
  outline.zoomIn('A')
  outline.reset()
  assertEqual(outline.zoomId.peek(), 'root', "zoomId should be 'root' after reset")
})


// ─── zoom ────────────────────────────────────────────────────────────────────

section("Zoom")

await test("zoomId starts at 'root'", () => {
  assertEqual(outline.zoomId.peek(), 'root', "Initial zoomId should be 'root'")
})

await test("zoomIn changes zoomId", () => {
  outline.addChild('root', { id: 'A' })
  outline.zoomIn('A')
  assertEqual(outline.zoomId.peek(), 'A', "zoomId should update to 'A'")
})

await test("getRoot returns the zoomed node after zoomIn", () => {
  outline.addChild('root', { id: 'A' })
  outline.zoomIn('A')
  assertEqual(outline.getRoot().id, 'A', "getRoot() should return the zoomed node")
})

await test("zoomOut moves zoomId to parent", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('A', { id: 'B' })
  outline.zoomIn('B')
  outline.zoomOut()
  assertEqual(outline.zoomId.peek(), 'A', "zoomOut should move up one level")
})

await test("zoomOut at root is a no-op", () => {
  outline.zoomOut()
  assertEqual(outline.zoomId.peek(), 'root', "zoomOut at root should stay at root")
})

await test("addChild without parentId adds to the current zoom root", () => {
  outline.addChild('root', { id: 'A' })
  outline.zoomIn('A')
  const child = outline.addChild(null, { id: 'B' })
  assertEqual(child.parentId, 'A', "Child should be parented to the zoom root A")
  assertChildren('A', ['B'])
})

await test("getVMD respects zoom — only renders subtree under zoomed node", () => {
  buildTree()
  outline.updateNode('D', { text: 'Delta' })
  outline.updateNode('E', { text: 'Echo' })
  outline.zoomIn('B')
  const vmd = outline.getVMD()
  // A and C are outside the zoom, should not appear
  assert(!vmd.includes('A'), "A should not appear in zoomed VMD")
  assert(!vmd.includes('C'), "C should not appear in zoomed VMD")
  assert(vmd.includes('Delta'), "D should appear in zoomed VMD")
})

await test("deserialize resets zoom to root when the zoomed node is absent from the new data", () => {
  outline.addChild('root', { id: 'A' })
  outline.zoomIn('A')
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: [{ id: 'root', parentId: null, text: '', description: '', children: [], open: true }]
  })
  outline.deserialize(data)
  assertEqual(outline.zoomId.peek(), 'root', "zoomId should fall back to root after deserialization removes the zoomed node")
})


// ─── navigation (next / prev) ────────────────────────────────────────────────

section("Navigation (next / prev)")

// tree for this section: root → [A, B, C],  A → [D, E]
function buildNavTree() {
  outline.addChild('root', { id: 'A', text: 'A' })
  outline.addChild('root', { id: 'B', text: 'B' })
  outline.addChild('root', { id: 'C', text: 'C' })
  outline.addChild('A', { id: 'D', text: 'D' })
  outline.addChild('A', { id: 'E', text: 'E' })
}

await test("next from an open parent returns its first child", () => {
  buildNavTree()
  assertEqual(outline.next('A'), 'D', "next(A) should be D")
})

await test("next from an intermediate leaf returns the next sibling", () => {
  buildNavTree()
  assertEqual(outline.next('D'), 'E', "next(D) should be E")
})

await test("next from the last child ascends to the parent's next sibling", () => {
  buildNavTree()
  assertEqual(outline.next('E'), 'B', "next(E) should be B, skipping back up past A")
})

await test("next from the last node in the tree returns null", () => {
  buildNavTree()
  assert(outline.next('C') === null, "next(C) should be null — end of tree")
})

await test("next skips into children of closed nodes", () => {
  // closed nodes skip drill-down, so next goes to next sibling
  buildNavTree()
  outline.toggleOpen('A') // close A so its children are skipped
  assertEqual(outline.next('A'), 'B', "next(A) when closed should skip D and go to B")
})

await test("next on an unknown id returns null", () => {
  assert(outline.next('nonexistent') === null, "next on unknown id should return null")
})

await test("prev from the first child returns its parent", () => {
  buildNavTree()
  assertEqual(outline.prev('D'), 'A', "prev(D) should be A, its parent")
})

await test("prev returns the last open descendant of the previous sibling", () => {
  buildNavTree()
  // B's previous sibling is A, whose last open descendant is E
  assertEqual(outline.prev('B'), 'E', "prev(B) should be E, the deepest last child of A")
})

await test("prev returns the previous sibling directly when it is closed", () => {
  buildNavTree()
  outline.toggleOpen('A') // close A — its children are not traversed
  assertEqual(outline.prev('B'), 'A', "prev(B) with A closed should return A itself")
})

await test("prev from the first child of root returns root", () => {
  buildNavTree()
  assertEqual(outline.prev('A'), 'root', "prev(A) should return root")
})

await test("prev on an unknown id returns null", () => {
  assert(outline.prev('nonexistent') === null, "prev on unknown id should return null")
})


// ─── dataVersion tracking (extended) ────────────────────────────────────────

section("dataVersion tracking (extended)")

await test("moveDown increments version", async () => {
  buildTree()
  const v = outline.version.peek()
  await checkVersion(v + 1, () => outline.moveDown('A'))
})

await test("outdent increments version", async () => {
  buildTree()
  const v = outline.version.peek()
  await checkVersion(v + 1, () => outline.outdent('D'))
})

await test("deleteNode on a non-existent id does not increment version", async () => {
  const v = outline.version.peek()
  outline.deleteNode('nonexistent')
  await new Promise(r => setTimeout(r, 50))
  assertEqual(outline.version.peek(), v, "version should be unchanged after a no-op deleteNode")
})

section("Navigation Edge Cases")

await test("next() returns null when at the absolute end of the tree", () => {
  // Setup: root -> A -> B (B is the last leaf)
  outline.addChild('root', { id: 'A' })
  outline.addChild('A', { id: 'B' })

  // Logic check: next('B') should bubble up to root, find no next sibling, and return null
  const result = outline.next('B')
  assertEqual(result, null, "Should return null instead of throwing TypeError on parent.getChild")
})

await test("prev() returns null when called on the root node", () => {
  // The root has no parent, so prev() should handle the null parent gracefully
  const result = outline.prev('root')
  assertEqual(result, null, "Should return null for root navigation")
})

await test("next() skipping deep closed branches", () => {
  outline.addChild('root', { id: 'A', open: false })
  outline.addChild('A', { id: 'A1' })
  outline.addChild('root', { id: 'B' })

  assertEqual(outline.next('A'), 'B', "Should skip hidden child A1 and jump to sibling B")
})

section("VMD Parser Edge Cases")

await test("setVMD handles input starting with indentation", () => {
  const base = outline.addChild('root', { id: 'P' })
  // Simulating a partial paste that might have leading spaces
  const indentedVMD = "  - Indented Node\n    - Child"

  outline.setVMD(indentedVMD, 'P')
  const children = outline.get('P').children.peek()
  assert(children.length > 0, "Should successfully parse even with leading indentation")
})

await test("setVMD attaches multi-line descriptions to the correct nested node", () => {
  const base = outline.addChild('root', { id: 'P' })
  const complexVMD = "- Parent\n  - Child\n    Description for child\n    More description"

  outline.setVMD(complexVMD, 'P')
  const pNode = outline.get('P')
  const childId = pNode.children.peek()[0]
  const childNode = outline.get(childId)

  assertEqual(childNode.text.peek(), 'Child', "Child node text")
  assertEqual(childNode.description.peek(), "Description for child\nMore description", "Nested description mapping")
})

section("Integrity & Lifecycle")

await test("outdent updates parentId for all adopted siblings", () => {
  // B -> [D, E, F]. Outdent D. 
  // D should become sibling of B, and adopt [E, F].
  outline.addChild('root', { id: 'B' })
  outline.addChild('B', { id: 'D' })
  outline.addChild('B', { id: 'E' })
  outline.addChild('B', { id: 'F' })

  outline.outdent('D')

  assertEqual(outline.get('E').parentId, 'D', "Sibling E parentId must be updated to D")
  assertEqual(outline.get('F').parentId, 'D', "Sibling F parentId must be updated to D")
})

await test("deleteNode does not leave orphaned IDs in the parent's children array", () => {
  outline.addChild('root', { id: 'A' })
  outline.addChild('root', { id: 'B' })
  outline.deleteNode('A')

  const rootChildren = outline.get('root').children.peek()
  assertEqual(rootChildren.length, 1, "Array length should be 1")
  assert(!rootChildren.includes('A'), "Deleted ID should not exist in child array")
})

section("Reactivity & Timing")

await test("Multiple rapid updates are batched into a single version increment", async () => {
  const initialVersion = outline.version.peek()
  outline.addChild('root', { text: '1' })
  outline.addChild('root', { text: '2' })
  outline.addChild('root', { text: '3' })

  assert(outline.isDirty, "Should be dirty immediately")

  // Wait for the debounce timeout defined in outline.js (800ms default)
  await new Promise(r => setTimeout(r, outline.dirtyDebounceTimeout + 50))

  assertEqual(outline.version.peek(), initialVersion + 1, "Multiple changes should result in one version bump")
  assert(!outline.isDirty, "Should be clean after debounce")
})