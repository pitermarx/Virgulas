import outline from '../../../source/js/outline.js'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

const harness = createAsyncSectionHarness({ beforeEach: () => outline.reset() })
export const sections = harness.sections
const section = harness.section
const test = harness.test

function addChild(...args: Parameters<typeof outline.addChild>) {
    return outline.addChild(...args)!
}

section('getStats')

await test('counts nodes, words, characters, depth and collapse state', () => {
    addChild('root', { id: 'A', text: 'hello world' })
    const b = addChild('A', { id: 'B', text: 'deep node' })
    addChild('B', { id: 'C', text: '' })
    b.open.value = false

    const stats = outline.getStats()
    assertEqual(stats.nodeCount, 3, 'nodeCount excludes root')
    assertEqual(stats.wordCount, 4, 'word count')
    assertEqual(stats.charCount, 'hello world'.length + 'deep node'.length, 'char count')
    assertEqual(stats.maxDepth, 3, 'depth of C')
    assertEqual(stats.collapsedCount, 1, 'B is collapsed')
    assertEqual(stats.openCount, 1, 'A is open and has children')
})

await test('nodeCount includes the root while getStats excludes it', () => {
    addChild('root', { text: 'one' })
    addChild('root', { text: 'two' })
    assertEqual(outline.nodeCount, 3, 'outline.nodeCount includes root')
    assertEqual(outline.getStats().nodeCount, 2, 'getStats excludes root')
})

section('sibling helpers')

await test('nextSibling and prevSibling walk within the parent', () => {
    addChild('root', { id: 'A', text: 'A' })
    addChild('root', { id: 'B', text: 'B' })
    addChild('root', { id: 'C', text: 'C' })

    assertEqual(outline.nextSibling('A'), 'B', 'A -> B')
    assertEqual(outline.nextSibling('B'), 'C', 'B -> C')
    assertEqual(outline.nextSibling('C'), null, 'C has no next')
    assertEqual(outline.prevSibling('C'), 'B', 'C -> B')
    assertEqual(outline.prevSibling('A'), null, 'A has no previous')
    assertEqual(outline.nextSibling('missing'), null, 'unknown id')
})

section('getVMD defaults')

await test('getVMD() serialises the current zoom root', () => {
    addChild('root', { id: 'A', text: 'Alpha' })
    outline.zoomIn('A')
    assertEqual(outline.getVMD(), '- Alpha\n', 'zoomed root serialisation')
    outline.zoomOut()
    assert(outline.getVMD().includes('Alpha'), 'root serialisation contains the node')
})

section('setRootVMD validation')

await test('rejects a leading description line and reverts the document', () => {
    addChild('root', { id: 'A', text: 'Before' })
    let threw = false
    try {
        outline.setRootVMD('  orphan description\n- A\n')
    } catch (error) {
        threw = true
    }
    assert(threw, 'should throw')
    assertEqual(outline.get('A')!.text.peek(), 'Before', 'document reverted')
    assertEqual(outline.getRoot()!.children.peek().join(','), 'A', 'root children reverted')
})

section('deserialize parent validation')

await test('rejects parents that only exist on Object.prototype', () => {
    const doc = JSON.stringify({
        modelVersion: 'v1',
        dataVersion: 0,
        nodes: [
            { id: 'root', parentId: null, text: 'root', description: '', children: [], open: true },
            { id: 'ctor', parentId: 'constructor', text: 'ctor', description: '', children: [], open: true },
            { id: 'proto', parentId: '__proto__', text: 'proto', description: '', children: [], open: true },
            { id: 'tostr', parentId: 'toString', text: 'tostr', description: '', children: [], open: true }
        ]
    })

    outline.deserialize(doc)

    assertEqual(outline.get('ctor'), undefined, 'constructor parent rejected')
    assertEqual(outline.get('proto'), undefined, '__proto__ parent rejected')
    assertEqual(outline.get('tostr'), undefined, 'toString parent rejected')
    assertEqual(outline.get('root')!.children.peek().length, 0, 'root has no adopted children')
})
