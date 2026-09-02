import outline from './outline.js'
import inbox from './inbox.js'
import { store } from './utils.js'
import {
    assert,
    assertEqual,
    cloneSections,
    createAsyncSectionHarness,
    streamCompletedSections,
    summaryFromSections
} from './testing.js'

const harness = createAsyncSectionHarness({
    beforeEach: async () => {
        outline.reset()
        inbox.clear()
        inbox.setNodeName(inbox.DEFAULT_INBOX_NODE_NAME)
    }
})

export const sections = harness.sections
const section = harness.section
const test = harness.test

export function summary() {
    return summaryFromSections(sections)
}

export async function streamInboxTests(onProgress) {
    return streamCompletedSections(cloneSections(sections), onProgress, 5)
}

function nodeTexts(nodeId) {
    return outline.get(nodeId).children.peek().map(id => outline.get(id).text.peek())
}

section('Queue storage')

await test('enqueue stores non-empty captures on the device', () => {
    assertEqual(inbox.enqueue('  Buy milk  '), true, 'enqueue should report success')
    assertEqual(inbox.pendingCount(), 1, 'one capture should be pending')
    assertEqual(inbox.pendingItems()[0].text, 'Buy milk', 'capture text should be trimmed')
    assert(store.inboxQueue.get(''), 'queue should be stored separately from the document')
})

await test('empty captures are ignored', () => {
    assertEqual(inbox.enqueue('   '), false, 'blank text should not be queued')
    assertEqual(inbox.pendingCount(), 0, 'blank text should leave the queue empty')
})

section('Reconciliation')

await test('creates the configured root Inbox node and preserves order', () => {
    inbox.enqueue('First')
    inbox.enqueue('Second')

    assertEqual(inbox.reconcile(), 2, 'both captures should be imported')
    const rootChildren = outline.get('root').children.peek()
    assertEqual(rootChildren.length, 1, 'one Inbox node should be created')
    const inboxNode = outline.get(rootChildren[0])
    assertEqual(inboxNode.text.peek(), 'Inbox', 'default Inbox node should be named Inbox')
    assertEqual(nodeTexts(inboxNode.id).join('|'), 'First|Second', 'captures should retain queue order')
    assertEqual(inbox.pendingCount(), 0, 'imported captures should be removed from the queue')
})

await test('uses a custom Inbox node name', () => {
    inbox.setNodeName('  Someday  ')
    inbox.enqueue('Read this later')

    inbox.reconcile()

    const rootChildren = outline.get('root').children.peek()
    assertEqual(outline.get(rootChildren[0]).text.peek(), 'Someday', 'custom name should be normalized and used')
})

await test('reuses an existing matching root child', () => {
    const existing = outline.addChild('root', { id: 'existing-inbox', text: 'Inbox' })
    inbox.enqueue('Use existing node')

    assertEqual(inbox.reconcile(), 1, 'capture should be imported')
    assertEqual(outline.get('root').children.peek().length, 1, 'a duplicate Inbox node should not be created')
    assertEqual(nodeTexts(existing.id)[0], 'Use existing node', 'capture should be nested under the existing node')
})

await test('reconciliation is a no-op with an empty queue', () => {
    outline.addChild('root', { id: 'existing', text: 'Existing' })
    assertEqual(inbox.reconcile(), 0, 'empty reconciliation should import nothing')
    assertEqual(outline.get('root').children.peek().length, 1, 'empty reconciliation should not add a node')
})

await test('the configured name survives reload-style storage reads', () => {
    inbox.setNodeName('Later')
    // Re-read through the public storage-backed API rather than relying on the
    // signal/UI layer that owns the Options field.
    assertEqual(inbox.getNodeName(), 'Later', 'configured name should be persisted on-device')
})
