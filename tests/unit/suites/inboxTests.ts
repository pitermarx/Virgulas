import outline from '../../../source/js/outline.js'
import inbox from '../../../source/js/inbox.js'
import { store } from '../../../source/js/utils.js'
import {
    assert,
    assertEqual,
    cloneSections,
    createAsyncSectionHarness,
    streamCompletedSections,
    summaryFromSections
} from '../testing.js'

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

export async function streamInboxTests(onProgress: any) {
    return streamCompletedSections(cloneSections(sections), onProgress, 5)
}

function nodeTexts(nodeId: string) {
    return outline.get(nodeId)!.children.peek().map(id => outline.get(id)!.text.peek())
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

await test('enqueue keeps an optional description', () => {
    assertEqual(inbox.enqueue('[Title](https://example.com)', '  a highlighted quote  '), true, 'enqueue should succeed')

    const entry = inbox.pendingItems()[0]
    assertEqual(entry.text, '[Title](https://example.com)', 'text should be stored')
    assertEqual(entry.description, 'a highlighted quote', 'description should be trimmed and stored')
})

section('Reconciliation')

await test('creates the configured root Inbox node and preserves order', () => {
    inbox.enqueue('First')
    inbox.enqueue('Second')

    assertEqual(inbox.reconcile(), 2, 'both captures should be imported')
    const rootChildren = outline.get('root')!.children.peek()
    assertEqual(rootChildren.length, 1, 'one Inbox node should be created')
    const inboxNode = outline.get(rootChildren[0])!
    assertEqual(inboxNode.text.peek(), 'Inbox', 'default Inbox node should be named Inbox')
    assertEqual(nodeTexts(inboxNode.id).join('|'), 'First|Second', 'captures should retain queue order')
    assertEqual(inbox.pendingCount(), 0, 'imported captures should be removed from the queue')
})

await test('uses a custom Inbox node name', () => {
    inbox.setNodeName('  Someday  ')
    inbox.enqueue('Read this later')

    inbox.reconcile()

    const rootChildren = outline.get('root')!.children.peek()
    assertEqual(outline.get(rootChildren[0])!.text.peek(), 'Someday', 'custom name should be normalized and used')
})

await test('reuses an existing matching root child', () => {    const existing = outline.addChild('root', { id: 'existing-inbox', text: 'Inbox' })!
    inbox.enqueue('Use existing node')

    assertEqual(inbox.reconcile(), 1, 'capture should be imported')
    assertEqual(outline.get('root')!.children.peek().length, 1, 'a duplicate Inbox node should not be created')
    assertEqual(nodeTexts(existing.id)[0], 'Use existing node', 'capture should be nested under the existing node')
})

await test('restores the description on the imported node', () => {
    inbox.enqueue('[Title](https://example.com)', 'a highlighted quote')

    assertEqual(inbox.reconcile(), 1, 'capture should be imported')

    const inboxNodeId = outline.get('root')!.children.peek()[0]
    const importedId = outline.get(inboxNodeId)!.children.peek()[0]
    const imported = outline.get(importedId)!
    assertEqual(imported.text.peek(), '[Title](https://example.com)', 'node text should be the markdown link')
    assertEqual(imported.description.peek(), 'a highlighted quote', 'node description should be restored')
})

await test('reconciliation is a no-op with an empty queue', () => {
    outline.addChild('root', { id: 'existing', text: 'Existing' })
    assertEqual(inbox.reconcile(), 0, 'empty reconciliation should import nothing')
    assertEqual(outline.get('root')!.children.peek().length, 1, 'empty reconciliation should not add a node')
})

await test('the configured name survives reload-style storage reads', () => {
    inbox.setNodeName('Later')
    // Re-read through the public storage-backed API rather than relying on the
    // signal/UI layer that owns the Options field.
    assertEqual(inbox.getNodeName(), 'Later', 'configured name should be persisted on-device')
})

section('Capture URL parsing')

const parse = (search: string) => inbox.parseCaptureUrl(new URL(`https://virgulas.test/${search}`))

await test('a plain visit is not a capture', () => {
    assertEqual(parse(''), null, 'no capture parameters means no capture intent')
    assertEqual(parse('?zoom=n1'), null, 'unrelated parameters are not captures')
})

await test('quick-add is a direct capture with trimmed text', () => {
    const intent = parse('?quick-add=%20%20buy%20milk%20%20')
    assertEqual(intent?.kind, 'direct', 'quick-add should capture directly')
    assertEqual(intent?.text, 'buy milk', 'captured text should be trimmed')
})

await test('an empty quick-add falls back to the prompt', () => {
    assertEqual(parse('?quick-add=')?.kind, 'prompt', 'empty quick-add should ask for text')
    assertEqual(parse('?quick-add=%20%20')?.kind, 'prompt', 'whitespace-only quick-add should ask for text')
})

await test('quick-capture opens the prompt', () => {
    const intent = parse('?quick-capture=1')
    assertEqual(intent?.kind, 'prompt', 'quick-capture should prompt')
    assertEqual(intent?.text, '', 'prompt captures carry no text')
})

await test('a page becomes a markdown link with the selection as its description', () => {
    const intent = parse('?title=Buy%20milk&text=Remember%20to%20buy%20milk&url=https%3A%2F%2Fexample.com')
    assertEqual(intent?.kind, 'direct', 'share-target payloads capture directly')
    assertEqual(intent?.text, '[Buy milk](https://example.com)', 'the page becomes a markdown link')
    assertEqual(intent?.description, 'Remember to buy milk', 'the selection becomes the description')
})

await test('a page without a selection has no description', () => {
    const intent = parse('?title=Buy%20milk&url=https%3A%2F%2Fexample.com')
    assertEqual(intent?.text, '[Buy milk](https://example.com)', 'link should still be built')
    assertEqual(intent?.description, '', 'there is no selection to store')
})

await test('a missing title falls back to the URL as the link text', () => {
    const intent = parse('?url=https%3A%2F%2Fexample.com')
    assertEqual(intent?.text, '[https://example.com](https://example.com)', 'URL should label the link')
})

await test('a selection that just repeats the URL is not duplicated', () => {
    const intent = parse('?title=Example&text=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.com')
    assertEqual(intent?.text, '[Example](https://example.com)', 'link should be built')
    assertEqual(intent?.description, '', 'a repeated URL should not become a description')
})

await test('a selection that just repeats the title is not duplicated', () => {
    const intent = parse('?title=Example&text=Example&url=https%3A%2F%2Fexample.com')
    assertEqual(intent?.description, '', 'a repeated title should not become a description')
})

await test('a payload without a URL uses the text as the node text', () => {
    assertEqual(parse('?text=just%20a%20note')?.text, 'just a note', 'text should become the node')
    assertEqual(parse('?title=Only%20a%20title')?.text, 'Only a title', 'title should become the node')
})

await test('an empty share-target payload falls back to the prompt', () => {
    assertEqual(parse('?title=&text=&url=')?.kind, 'prompt', 'blank share payload should ask for text')
})

section('Bookmarklet')

await test('builds a javascript URL that opens the capture popup', () => {
    const bookmarklet = inbox.buildBookmarklet('https://virgulas.test/')

    assert(bookmarklet.startsWith('javascript:'), 'bookmarklets must be javascript: URLs')
    assert(bookmarklet.includes("window.open('https://virgulas.test/?'"), 'should open the app with capture params')
    assert(bookmarklet.includes('virgulas-capture'), 'should reuse a single named capture window')
})

await test('sends the page title, its URL and the current selection', () => {
    const bookmarklet = inbox.buildBookmarklet('https://virgulas.test/')

    assert(bookmarklet.includes("q.set('title',document.title||'')"), 'should send the page title')
    assert(bookmarklet.includes("q.set('url',location.href)"), 'should send the page URL')
    assert(bookmarklet.includes('window.getSelection()'), 'should read the current selection')
    assert(bookmarklet.includes("if(s)q.set('text',s)"), 'should only send text when something is selected')
})
