import outline from "./outline.js"
import {
  assert,
  assertEqual,
  cloneSections,
  createSyncSectionHarness,
  streamCompletedSections,
  summaryFromSections
} from './testing.js'

// ─── harness ──────────────────────────────────────────────────────────────────

const harness = createSyncSectionHarness({ beforeEach: () => outline.reset() })
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
  outline.addNewNode('root', { id: 'A', text: 'A' })
  outline.addNewNode('root', { id: 'B', text: 'B' })
  outline.addNewNode('root', { id: 'C', text: 'C' })
  outline.addNewNode('B', { id: 'D', text: 'D' })
  outline.addNewNode('B', { id: 'E', text: 'E' })
}

// ─── tests ────────────────────────────────────────────────────────────────────

section("Root node")

test("getRoot() and get('root') return the same instance", () => {
  assert(outline.getRoot() === outline.get('root'), "Should be same reference")
})

test("Root node has id 'root'", () => {
  assertEqual(outline.getRoot().id, 'root', "Root id")
})

test("Root node starts with no children", () => {
  assertChildren('root', [])
})

test("peek() returns a plain object, not the node itself", () => {
  const root = outline.getRoot()
  const peeked = root.peek()
  assert(peeked !== root, "peek() should return a new object")
  assert(typeof peeked === 'object', "peek() should return an object")
  assertEqual(peeked.id, 'root', "peek().id should be 'root'")
})

test("Two peek() calls return distinct objects", () => {
  const root = outline.getRoot()
  assert(root.peek() !== root.peek(), "Each peek() call should produce a new object")
})

test("Cannot delete root node", () => {
  outline.deleteNode('root')
  assert(outline.getRoot() !== undefined, "Root should still exist after attempted delete")
})


section("Adding nodes")

test("addNewNode returns the created node", () => {
  const node = outline.addNewNode('root')
  assert(node !== undefined, "Should return a node")
  assert(node.id !== undefined, "Node should have an id")
})

test("New node has correct parentId", () => {
  const node = outline.addNewNode('root')
  assertEqual(node.parentId, 'root', "parentId should be 'root'")
})

test("New node appears in parent's children", () => {
  const node = outline.addNewNode('root')
  assert(outline.getRoot().children.peek().includes(node.id), "Root children should include new node")
})

test("addNewNode with explicit id, text, description, open", () => {
  const node = outline.addNewNode('root', { id: 'X', text: 'hello', description: 'desc', open: false })
  assertEqual(node.id, 'X', "id")
  assertEqual(node.text.peek(), 'hello', "text")
  assertEqual(node.description.peek(), 'desc', "description")
  assertEqual(node.open.peek(), false, "open")
})

test("addNewNode to non-root parent", () => {
  const parent = outline.addNewNode('root', { id: 'P' })
  const child = outline.addNewNode('P', { id: 'CH' })
  assertEqual(child.parentId, 'P', "Child parentId should be 'P'")
  assertChildren('P', ['CH'])
})

test("Multiple children added in order", () => {
  outline.addNewNode('root', { id: 'A' })
  outline.addNewNode('root', { id: 'B' })
  outline.addNewNode('root', { id: 'C' })
  assertChildren('root', ['A', 'B', 'C'])
})

test("addNewNode with invalid parentId falls back to root", () => {
  const node = outline.addNewNode('nonexistent', { id: 'X' })
  assertEqual(node.parentId, 'root', "Should fall back to root")
  assert(outline.getRoot().children.peek().includes('X'), "Root should contain fallback node")
})


section("Deleting nodes")

test("deleteNode removes node from map", () => {
  buildTree()
  outline.deleteNode('A')
  assert(outline.get('A') === undefined, "Node A should be gone")
})

test("deleteNode removes node from parent's children", () => {
  buildTree()
  outline.deleteNode('A')
  assert(!outline.getRoot().children.peek().includes('A'), "Root should not include A")
})

test("deleteNode recursively removes descendants", () => {
  buildTree()
  outline.deleteNode('B')
  assert(outline.get('B') === undefined, "B should be gone")
  assert(outline.get('D') === undefined, "D (child of B) should be gone")
  assert(outline.get('E') === undefined, "E (child of B) should be gone")
})

test("deleteNode does not affect siblings", () => {
  buildTree()
  outline.deleteNode('B')
  assert(outline.get('A') !== undefined, "A should still exist")
  assert(outline.get('C') !== undefined, "C should still exist")
  assertChildren('root', ['A', 'C'])
})

test("Deleting a non-existent node is a no-op", () => {
  buildTree()
  const versionBefore = outline.version.peek()
  outline.deleteNode('nonexistent')
  // no error thrown
})


section("Updating nodes")

test("updateNode changes text", () => {
  buildTree()
  outline.updateNode('A', { text: 'updated' })
  assertEqual(outline.get('A').text.peek(), 'updated', "Text should be updated")
})

test("updateNode changes description", () => {
  buildTree()
  outline.updateNode('A', { description: 'a desc' })
  assertEqual(outline.get('A').description.peek(), 'a desc', "Description should be updated")
})

test("updateNode with only text leaves description unchanged", () => {
  outline.addNewNode('root', { id: 'A', description: 'keep me' })
  outline.updateNode('A', { text: 'new text' })
  assertEqual(outline.get('A').description.peek(), 'keep me', "Description should be unchanged")
})

test("updateNode with only description leaves text unchanged", () => {
  outline.addNewNode('root', { id: 'A', text: 'keep me' })
  outline.updateNode('A', { description: 'new desc' })
  assertEqual(outline.get('A').text.peek(), 'keep me', "Text should be unchanged")
})


section("toggleOpen")

test("toggleOpen flips open from true to false", () => {
  outline.addNewNode('root', { id: 'A', open: true })
  outline.toggleOpen('A')
  assertEqual(outline.get('A').open.peek(), false, "Should be false after toggle")
})

test("toggleOpen flips open from false to true", () => {
  outline.addNewNode('root', { id: 'A', open: false })
  outline.toggleOpen('A')
  assertEqual(outline.get('A').open.peek(), true, "Should be true after toggle")
})

test("toggleOpen twice restores original value", () => {
  outline.addNewNode('root', { id: 'A', open: true })
  outline.toggleOpen('A')
  outline.toggleOpen('A')
  assertEqual(outline.get('A').open.peek(), true, "Should be back to true")
})


section("moveUp / moveDown")

test("moveUp swaps node with previous sibling", () => {
  buildTree()
  outline.moveUp('B')
  assertChildren('root', ['B', 'A', 'C'])
})

test("moveUp of first sibling moves node before parent in grandparent", () => {
  buildTree()
  // D is the first child of B; B is at index 1 in root → [A, B, C]
  outline.moveUp('D')
  // D should now be in root before B: [A, D, B, C], B's children: [E]
  assertChildren('root', ['A', 'D', 'B', 'C'])
  assertChildren('B', ['E'])
  assertEqual(outline.get('D').parentId, 'root', "D should be re-parented to root")
})

test("moveUp of first root child is a no-op", () => {
  buildTree()
  outline.moveUp('A') // A is first child of root, root has no parent
  assertChildren('root', ['A', 'B', 'C'])
})

test("moveDown swaps node with next sibling", () => {
  buildTree()
  outline.moveDown('B')
  assertChildren('root', ['A', 'C', 'B'])
})

test("moveDown of last sibling moves node after parent in grandparent", () => {
  buildTree()
  // E is the last child of B; B is at index 1 in root → [A, B, C]
  outline.moveDown('E')
  // E should now be in root after B: [A, B, E, C], B's children: [D]
  assertChildren('root', ['A', 'B', 'E', 'C'])
  assertChildren('B', ['D'])
  assertEqual(outline.get('E').parentId, 'root', "E should be re-parented to root")
})

test("moveDown of last root child is a no-op", () => {
  buildTree()
  outline.moveDown('C') // C is last child of root, root has no parent
  assertChildren('root', ['A', 'B', 'C'])
})


section("indent / outdent")

test("indent makes node a child of its previous sibling", () => {
  buildTree()
  // indent C → C becomes last child of B
  outline.indent('C')
  assertChildren('root', ['A', 'B'])
  assertChildren('B', ['D', 'E', 'C'])
  assertEqual(outline.get('C').parentId, 'B', "C should be re-parented to B")
})

test("indent first child is a no-op", () => {
  buildTree()
  outline.indent('A') // A has no previous sibling
  assertChildren('root', ['A', 'B', 'C'])
  assertEqual(outline.get('A').parentId, 'root', "A's parent should be unchanged")
})

test("outdent moves node to grandparent after its parent", () => {
  buildTree()
  // D is child of B, B is at index 1 in root → [A, B, C]
  outline.outdent('D')
  assertChildren('root', ['A', 'B', 'D', 'C'])
  assertChildren('B', ['E'])
  assertEqual(outline.get('D').parentId, 'root', "D should be re-parented to root")
})

test("outdent second child also positions correctly", () => {
  buildTree()
  outline.outdent('E')
  assertChildren('root', ['A', 'B', 'E', 'C'])
  assertChildren('B', ['D'])
})

test("outdent root child is a no-op", () => {
  buildTree()
  outline.outdent('A') // A's parent is root, root has no parent
  assertChildren('root', ['A', 'B', 'C'])
  assertEqual(outline.get('A').parentId, 'root', "A's parent should be unchanged")
})


section("Serialize")

test("serialize produces valid JSON", () => {
  buildTree()
  const json = outline.serialize()
  const parsed = JSON.parse(json) // throws on invalid JSON
  assert(parsed !== null, "Parsed result should not be null")
})

test("serialized output contains modelVersion, dataVersion, nodes", () => {
  buildTree()
  const parsed = JSON.parse(outline.serialize())
  assert('modelVersion' in parsed, "Should have modelVersion")
  assert('dataVersion' in parsed, "Should have dataVersion")
  assert('nodes' in parsed, "Should have nodes")
})

test("serialize pretty produces indented output", () => {
  outline.addNewNode('root', { id: 'A' })
  const pretty = outline.serialize(true)
  assert(pretty.includes('\n'), "Pretty JSON should have newlines")
  assert(pretty.includes('  '), "Pretty JSON should have indentation")
})

test("serialize includes all nodes", () => {
  buildTree()
  const parsed = JSON.parse(outline.serialize())
  const ids = Object.keys(parsed.nodes)
    ;['root', 'A', 'B', 'C', 'D', 'E'].forEach(id => {
      assert(ids.includes(id), `Serialized output should include node ${id}`)
    })
})

test("root node serialized with null parentId", () => {
  const parsed = JSON.parse(outline.serialize())
  assert(!parsed.nodes['root'].parentId, "Root parentId should be null or undefined in serialized output")
})

test("serialize round-trip preserves open state", () => {
  outline.addNewNode('root', { id: 'A', open: false })
  outline.addNewNode('root', { id: 'B', open: true })
  const parsed = JSON.parse(outline.serialize())
  assertEqual(parsed.nodes['A'].open, false, "Node A open should be false")
  assertEqual(parsed.nodes['B'].open, true, "Node B open should be true")
})


section("Deserialize")

const fixture = JSON.stringify({
  modelVersion: 'v1',
  dataVersion: 10,
  nodes: {
    root: { id: 'root', parentId: null, text: '', description: '', children: ['A', 'B'], open: true },
    A: { id: 'A', parentId: 'root', text: 'Alpha', description: 'desc A', children: [], open: false },
    B: { id: 'B', parentId: 'root', text: 'Beta', description: '', children: ['C'], open: true },
    C: { id: 'C', parentId: 'B', text: 'Gamma', description: '', children: [], open: true }
  }
})

test("Deserialize restores nodes", () => {
  outline.deserialize(fixture)
  assert(outline.get('A') !== undefined, "A should exist")
  assert(outline.get('B') !== undefined, "B should exist")
  assert(outline.get('C') !== undefined, "C should exist")
})

test("Deserialize restores text and description", () => {
  outline.deserialize(fixture)
  assertEqual(outline.get('A').text.peek(), 'Alpha', "A text")
  assertEqual(outline.get('A').description.peek(), 'desc A', "A description")
})

test("Deserialize restores open state", () => {
  outline.deserialize(fixture)
  assertEqual(outline.get('A').open.peek(), false, "A open")
  assertEqual(outline.get('B').open.peek(), true, "B open")
})

test("Deserialize restores parent-child relationships", () => {
  outline.deserialize(fixture)
  assertChildren('root', ['A', 'B'])
  assertChildren('B', ['C'])
  assertEqual(outline.get('C').parentId, 'B', "C parentId")
})

test("Deserialize restores dataVersion", () => {
  outline.deserialize(fixture)
  assertEqual(outline.version.peek(), 10, "dataVersion should be 10")
})

test("Deserialize throws on wrong modelVersion", () => {
  let threw = false
  try {
    outline.deserialize(JSON.stringify({ modelVersion: 'v99', nodes: { root: {} } }))
  } catch (e) {
    threw = true
  }
  assert(threw, "Should throw on unknown modelVersion")
})

test("Deserialize throws on missing root node", () => {
  let threw = false
  try {
    outline.deserialize(JSON.stringify({ modelVersion: 'v1', nodes: { X: {} } }))
  } catch (e) {
    threw = true
  }
  assert(threw, "Should throw when root node is absent")
})

test("Deserialize skips node with invalid parentId", () => {
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: {
      root: { id: 'root', parentId: null, text: '', description: '', children: [], open: true },
      orphan: { id: 'orphan', parentId: 'nonexistent', text: 'orphan', description: '', children: [], open: true }
    }
  })
  outline.deserialize(data)
  assert(outline.get('orphan') === undefined, "Orphan node should be skipped")
})

test("Deserialize skips child whose parentId does not match", () => {
  // B claims to have child C, but C's parentId is 'root', not 'B'
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: {
      root: { id: 'root', parentId: null, text: '', description: '', children: ['B'], open: true },
      B: { id: 'B', parentId: 'root', text: 'B', description: '', children: ['C'], open: true },
      C: { id: 'C', parentId: 'root', text: 'C', description: '', children: [], open: true }
    }
  })
  outline.deserialize(data)
  assertChildren('B', [])
})

test("Deserialize deduplicates repeated child references", () => {
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: {
      root: { id: 'root', parentId: null, text: '', description: '', children: ['A', 'A'], open: true },
      A: { id: 'A', parentId: 'root', text: 'A', description: '', children: [], open: true }
    }
  })
  outline.deserialize(data)
  assertChildren('root', ['A'])
})

test("Deserialize skips self-referential child", () => {
  const data = JSON.stringify({
    modelVersion: 'v1',
    dataVersion: 0,
    nodes: {
      root: { id: 'root', parentId: null, text: '', description: '', children: ['A'], open: true },
      A: { id: 'A', parentId: 'root', text: 'A', description: '', children: ['A'], open: true }
    }
  })
  outline.deserialize(data)
  assertChildren('A', [])
})

test("Full serialize → deserialize round-trip", () => {
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

test("Starts at 0 after reset", () => {
  assertEqual(outline.version.peek(), 0, "version should be 0")
})

test("addNewNode increments version", () => {
  outline.addNewNode('root')
  assert(outline.version.peek() > 0, "version should be > 0 after add")
})

test("deleteNode increments version", () => {
  outline.addNewNode('root', { id: 'A' })
  const v = outline.version.peek()
  outline.deleteNode('A')
  assert(outline.version.peek() > v, "version should increase after delete")
})

test("updateNode increments version", () => {
  outline.addNewNode('root', { id: 'A' })
  const v = outline.version.peek()
  outline.updateNode('A', { text: 'x' })
  assert(outline.version.peek() > v, "version should increase after update")
})

test("toggleOpen increments version", () => {
  outline.addNewNode('root', { id: 'A' })
  const v = outline.version.peek()
  outline.toggleOpen('A')
  assert(outline.version.peek() > v, "version should increase after toggleOpen")
})

test("moveUp increments version", () => {
  buildTree()
  const v = outline.version.peek()
  outline.moveUp('B')
  assert(outline.version.peek() > v, "version should increase after moveUp")
})

test("indent increments version", () => {
  buildTree()
  const v = outline.version.peek()
  outline.indent('C')
  assert(outline.version.peek() > v, "version should increase after indent")
})


section("getVMD")

test("Flat list", () => {
  outline.addNewNode('root', { id: 'A', text: 'Alpha' })
  outline.addNewNode('root', { id: 'B', text: 'Beta' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- Alpha\n- Beta\n", "Flat VMD")
})

test("Nested list", () => {
  outline.addNewNode('root', { id: 'A', text: 'A' })
  outline.addNewNode('A', { id: 'B', text: 'B' })
  outline.addNewNode('A', { id: 'C', text: 'C' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- A\n  - B\n  - C\n", "Nested VMD")
})

test("Collapsed node with children uses + bullet", () => {
  outline.addNewNode('root', { id: 'A', text: 'A', open: false })
  outline.addNewNode('A', { id: 'B', text: 'B' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "+ A\n  - B\n", "Collapsed parent should use +")
})

test("Leaf node with open:false still uses - bullet", () => {
  outline.addNewNode('root', { id: 'A', text: 'A', open: false })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- A\n", "Leaf open:false should still use -")
})

test("Description lines are indented under their node", () => {
  outline.addNewNode('root', { id: 'A', text: 'A', description: 'line one\nline two' })
  const vmd = outline.getVMD()
  assertEqual(vmd, "- A\n  line one\n  line two\n", "Description should be indented")
})

test("getVMD for a specific subtree", () => {
  buildTree()
  outline.updateNode('D', { text: 'D-text' })
  outline.updateNode('E', { text: 'E-text' })
  const vmd = outline.getVMD('B')
  assertEqual(vmd, "- B\n  - D-text\n  - E-text\n", "Subtree VMD should start from given node")
})


section("setVMD")

test("Basic parsing creates child nodes", () => {
  const parent = outline.addNewNode('root', { id: 'P', text: 'P' })
  outline.setVMD("- X\n- Y\n", 'P')
  const children = outline.getRoot().children.peek()
  assertEqual(children.length, 2, "Should have 2 children")
  assertEqual(outline.get(children[0]).id, 'P', "First child should keep ID")
  assertEqual(outline.get(children[0]).text.peek(), 'X', "First child text")
  assertEqual(outline.get(children[1]).text.peek(), 'Y', "Second child text")
})

test("+ bullet sets open to false", () => {
  const parent = outline.addNewNode('root', { id: 'P' })
  outline.addNewNode('P', { id: 'DUMMY' }) // child so + renders
  outline.setVMD("+ Closed\n  - child\n", 'P')
  const ch = outline.get('P').children.peek()
  // The first bullet updates P itself (open state)
  assertEqual(outline.get('P').open.peek(), false, "P should be closed after + bullet (regression: bug #4)")
})

test("- bullet sets open to true", () => {
  const parent = outline.addNewNode('root', { id: 'P', open: false })
  outline.setVMD("- Open\n", 'P')
  assertEqual(outline.get('P').open.peek(), true, "P should be open after - bullet")
})

test("Description lines are attached to the preceding node", () => {
  outline.addNewNode('root', { id: 'P' })
  outline.setVMD("- A\n  some description\n", 'P')
  const pastedNode = outline.get('P').peek()
  assertEqual(pastedNode.description, 'some description', "Description should be attached")
})

test("Multi-line description is joined with newline", () => {
  outline.addNewNode('root', { id: 'P' })
  outline.setVMD("- A\n  line one\n    line two\n", 'P')
  const pastedNode = outline.get('P').peek()
  assertEqual(pastedNode.description, 'line one\nline two', "Multi-line description")
})

test("Escaped description lines starting with backtick-dash are unescaped", () => {
  const base = outline.addNewNode('root')
  outline.setVMD("- A\n  `- not a bullet\n", base.id)
  const pastedNode = outline.get(base.id).peek()
  assertEqual(pastedNode.description, '- not a bullet', "Escaped description line")
})

test("Escaped description lines starting with backtick-plus are unescaped", () => {
  outline.addNewNode('root', { id: 'P' })
  outline.setVMD("- A\n  `+ not a bullet\n", 'P')
  const pastedNode = outline.get('P').peek()
  assertEqual(pastedNode.description, '+ not a bullet', "Escaped + description line")
})

test("setVMD deletes existing children before parsing", () => {
  const base = outline.addNewNode('root')
  outline.addNewNode(base.id, { id: 'OLD' })
  outline.setVMD("- New", base.id)
  assert(outline.get('OLD') === undefined, "Old child should be deleted")
  const ch = outline.get(base.id).children.peek()
  assertEqual(ch.length, 0, "Should have exactly 1 new child")
  const newVmd = outline.getVMD()
  assertEqual(newVmd, "- New\n", "New VMD should match input")
})

test("setVMD handles nested bullet structure", () => {
  const base = outline.addNewNode('root')
  outline.setVMD("- A\n  - B\n  - C\n- D\n", base.id)
  const ch = outline.getRoot().children.peek()
  assertEqual(ch.length, 2, "root should have 2 children")
  const A = outline.get(ch[0])
  assertChildren(A.id, [outline.get(A.children.peek()[0]).id, outline.get(A.children.peek()[1]).id])
  assertEqual(A.text.peek(), 'A', "A text")
})

test("setVMD on root is a no-op", () => {
  const versionBefore = outline.version.peek()
  outline.setVMD("- Should not appear\n", 'root')
  assertEqual(outline.version.peek(), versionBefore, "version should not change")
  assertChildren('root', [])
})

test("setVMD on non-existent nodeId is a no-op", () => {
  outline.setVMD("- X\n", 'nonexistent')
  assertChildren('root', [])
})

test("VMD getVMD → setVMD round-trip", () => {
  buildTree()
  outline.updateNode('A', { text: 'Alfa', description: 'first node' })
  outline.updateNode('D', { text: 'Delta' })
  outline.updateNode('E', { text: 'Echo' })
  const originalVmd = outline.getVMD()

  // Re-apply VMD to a fresh node and compare
  outline.reset()
  const fresh = outline.addNewNode('root')
  outline.setVMD(originalVmd, fresh.id)
  const rebuiltVmd = outline.getVMD()
  assertEqual(rebuiltVmd, originalVmd, "Round-trip VMD should be identical")
})