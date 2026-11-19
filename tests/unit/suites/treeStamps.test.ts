import { describe, it, beforeEach } from 'bun:test'
// Structural mutations must stamp lastModified: merge compares per-node
// stamps to decide which side changed, and an un-stamped move is silently
// reverted by a merge that takes the remote's copy of the node.
import outline from '../../../source/js/outline.js'
import { assert } from '../testing.js'

beforeEach(() => outline.reset())

// Date.now() may not tick between statements, so advance the clock a little
// before capturing the "before" stamps.
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('structural changes stamp lastModified', () => {

  it('indent stamps the moved node', async () => {
    const a = outline.addChild('root', { text: 'A' })!
    const b = outline.addChild('root', { text: 'B' })!
    await tick()
    const before = b.peek().lastModified

    outline.indent(b.id)

    assert(outline.get(b.id)!.peek().lastModified > before, 'the indented node is stamped')
    assert(outline.get(b.id)!.peek().parentId === a.id, 'the move itself happened')
  })

  it('outdent stamps the moved node, its old parent and a sibling it adopted', async () => {
    const a = outline.addChild('root', { text: 'A' })!
    const b = outline.addChild(a.id, { text: 'B' })!
    const c = outline.addChild(a.id, { text: 'C' })!
    await tick()
    const beforeB = b.peek().lastModified
    const beforeA = a.peek().lastModified
    const beforeC = c.peek().lastModified

    outline.outdent(b.id)

    assert(outline.get(b.id)!.peek().lastModified > beforeB, 'the outdented node is stamped')
    assert(outline.get(a.id)!.peek().lastModified > beforeA, 'the old parent is stamped (its children list changed)')
    assert(outline.get(c.id)!.peek().lastModified > beforeC, 'the sibling moved under the node is stamped')
  })

  it('a sibling move stamps the shared parent, whose children order changed', async () => {
    const a = outline.addChild('root', { text: 'A' })!
    const b = outline.addChild('root', { text: 'B' })!
    await tick()
    const beforeRoot = outline.get('root')!.peek().lastModified

    outline.moveUp(b.id)

    assert(outline.get('root')!.peek().lastModified > beforeRoot, 'the parent is stamped')
    assert(outline.get('root')!.peek().children[0] === b.id, 'the order actually changed')
    void a
  })
})
