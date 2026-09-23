import { randomId } from './crypto2.js'
import outline, { type Node } from './outline.js'
import { log, store } from './utils.js'

export interface InboxEntry {
    id: string
    text: string
    description: string
    createdAt: number
}

export const DEFAULT_INBOX_NODE_NAME = 'Inbox'
export const INBOX_QUEUE_STORAGE_KEY = 'vmd_inbox_queue'
export const MAX_QUEUE_ITEMS = 500
export const MAX_ITEM_LENGTH = 10000
export const MAX_NODE_NAME_LENGTH = 100

/** Parameters used by the PWA share target (see source/site.webmanifest). */
export const SHARE_TARGET_KEYS = ['title', 'text', 'url'] as const

export interface CaptureIntent {
    /** `direct` queues immediately; `prompt` asks the user for text first. */
    kind: 'direct' | 'prompt'
    text: string
    description: string
}

/**
 * Turn a bookmarklet/share payload into a node: the page becomes a markdown
 * link in the node text and the highlighted selection becomes its description.
 * Returns null when the payload carries nothing usable.
 */
function linkCapture(title: string, url: string, selection: string) {
    const link = url ? `[${title || url}](${url})` : ''
    // Share sheets often repeat the URL in both `text` and `url`; do not turn
    // that duplicate into a description.
    const description = selection && selection !== url && selection !== title ? selection : ''

    if (link) return { text: link, description }
    if (selection) return { text: selection, description: '' }
    if (title) return { text: title, description: '' }
    return null
}

/**
 * Interpret a page URL as a quick-capture request, or return null when it is a
 * normal visit. Pure so the capture fast-path can be decided before the app
 * boots (a capture visit must never unlock or decrypt anything).
 */
export function parseCaptureUrl(url: URL): CaptureIntent | null {
    if (url.searchParams.has('quick-add')) {
        const text = (url.searchParams.get('quick-add') || '').trim()
        return text
            ? { kind: 'direct', text, description: '' }
            : { kind: 'prompt', text: '', description: '' }
    }

    if (url.searchParams.has('quick-capture')) {
        return { kind: 'prompt', text: '', description: '' }
    }

    if (SHARE_TARGET_KEYS.some(key => url.searchParams.has(key))) {
        const capture = linkCapture(
            (url.searchParams.get('title') || '').trim(),
            (url.searchParams.get('url') || '').trim(),
            (url.searchParams.get('text') || '').trim()
        )
        return capture
            ? { kind: 'direct', text: capture.text, description: capture.description }
            : { kind: 'prompt', text: '', description: '' }
    }

    return null
}

/**
 * Bookmarklet body: sends the page title, its URL and the current selection to
 * the capture URL. Only the literal bookmarklet source is used, so the target
 * page's own CSP may still refuse to run it on strict sites.
 */
export function buildBookmarklet(appUrl: string): string {
    const code = [
        '(()=>{',
        'const q=new URLSearchParams();',
        "q.set('title',document.title||'');",
        "q.set('url',location.href);",
        'const s=String(window.getSelection()).trim();',
        "if(s)q.set('text',s);",
        `window.open('${appUrl}?'+q,'virgulas-capture','width=480,height=640');`,
        '})()'
    ].join('')
    return `javascript:${code}`
}

function createEntryId() {
    return `inbox-${Date.now().toString(36)}-${randomId()}`
}

function normalizeText(text: unknown) {
    if (typeof text !== 'string') return ''
    return text.trim().slice(0, MAX_ITEM_LENGTH)
}

function normalizeNodeName(name: unknown) {
    if (typeof name !== 'string') return DEFAULT_INBOX_NODE_NAME
    const normalized = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_NAME_LENGTH)
    return normalized || DEFAULT_INBOX_NODE_NAME
}

function normalizeEntry(entry: any): InboxEntry | null {
    const text = normalizeText(typeof entry === 'string' ? entry : entry?.text)
    if (!text) return null

    const id = typeof entry === 'object' && entry?.id && entry.id !== 'root'
        ? String(entry.id)
        : createEntryId()
    const description = typeof entry === 'object' ? normalizeText(entry?.description) : ''
    const createdAt = typeof entry === 'object' && Number.isFinite(entry?.createdAt)
        ? entry.createdAt
        : Date.now()

    return { id, text, description, createdAt }
}

function readQueue(): InboxEntry[] {
    const raw = store.inboxQueue.get('')
    if (!raw) return []

    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        log('[Inbox] Ignoring malformed queue:', error)
        return []
    }

    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeEntry).filter((entry): entry is InboxEntry => entry !== null)
}

function writeQueue(items: InboxEntry[]) {
    if (!items.length) return store.inboxQueue.del()
    return store.inboxQueue.set(JSON.stringify(items))
}

function findInboxNode(name: string) {
    const root = outline.get('root')
    if (!root) return null

    return root.children.peek()
        .map(id => outline.get(id))
        .find(node => node && node.text.peek() === name) || null
}

export function getNodeName() {
    return normalizeNodeName(store.inboxNodeName.get(DEFAULT_INBOX_NODE_NAME))
}

export function setNodeName(name: string) {
    const normalized = normalizeNodeName(name)
    store.inboxNodeName.set(normalized)
    return normalized
}

export function enqueue(text: unknown, description: unknown = '') {
    const normalizedText = normalizeText(text)
    if (!normalizedText) return false

    const queue = readQueue()
    if (queue.length >= MAX_QUEUE_ITEMS) {
        log(`[Inbox] Queue is full (${MAX_QUEUE_ITEMS} items); rejecting new item`)
        return false
    }

    queue.push({
        id: createEntryId(),
        text: normalizedText,
        description: normalizeText(description),
        createdAt: Date.now()
    })
    return writeQueue(queue)
}

export function pendingCount() {
    return readQueue().length
}

export function pendingItems() {
    return readQueue().map(item => ({ ...item }))
}

export function clear() {
    return store.inboxQueue.del()
}

/**
 * Move queued captures into the configured direct child of the document root.
 * Queue entries use stable node IDs so a page interruption between adding a
 * node and clearing localStorage cannot duplicate items on the next unlock.
 */
export function reconcile() {
    const queued = readQueue()
    if (queued.length === 0) return 0

    const name = getNodeName()
    let inboxNode: Node | null = findInboxNode(name) ?? null
    if (!inboxNode) {
        inboxNode = outline.addChild('root', { text: name }) ?? null
    }
    if (!inboxNode) {
        log('[Inbox] Could not create or find the Inbox node')
        return 0
    }

    const remaining: InboxEntry[] = []
    let imported = 0

    for (const entry of queued) {
        const existing = outline.get(entry.id)
        if (
            existing &&
            existing.parentId === inboxNode.id &&
            existing.text.peek() === entry.text &&
            existing.description.peek() === entry.description
        ) {
            imported++
            continue
        }

        let added = outline.addChild(inboxNode.id, {
            id: entry.id,
            text: entry.text,
            description: entry.description
        })

        // An extremely unlikely ID collision can occur if a queue entry's ID
        // already belongs to another document node. Use a fresh ID rather than
        // leaving that item permanently stuck in the queue.
        if (!added) {
            added = outline.addChild(inboxNode.id, {
                id: createEntryId(),
                text: entry.text,
                description: entry.description
            })
        }

        if (added) imported++
        else remaining.push(entry)
    }

    // Only remove entries that are known to have been imported. If storage is
    // unavailable, the original queue remains; stable IDs make retry safe.
    if (!writeQueue(remaining)) {
        log('[Inbox] Could not update the queue after reconciliation; retrying is safe')
    }

    return imported
}

export default {
    DEFAULT_INBOX_NODE_NAME,
    INBOX_QUEUE_STORAGE_KEY,
    MAX_QUEUE_ITEMS,
    MAX_ITEM_LENGTH,
    MAX_NODE_NAME_LENGTH,
    SHARE_TARGET_KEYS,
    parseCaptureUrl,
    buildBookmarklet,
    getNodeName,
    setNodeName,
    enqueue,
    pendingCount,
    pendingItems,
    clear,
    reconcile
}
