import { randomId } from './crypto2.js'
import outline from './outline.js'
import { log, store } from './utils.js'

export const DEFAULT_INBOX_NODE_NAME = 'Inbox'
export const INBOX_QUEUE_STORAGE_KEY = 'vmd_inbox_queue'
export const MAX_QUEUE_ITEMS = 500
export const MAX_ITEM_LENGTH = 10000
export const MAX_NODE_NAME_LENGTH = 100

function createEntryId() {
    return `inbox-${Date.now().toString(36)}-${randomId()}`
}

function normalizeText(text) {
    if (typeof text !== 'string') return ''
    return text.trim().slice(0, MAX_ITEM_LENGTH)
}

function normalizeNodeName(name) {
    if (typeof name !== 'string') return DEFAULT_INBOX_NODE_NAME
    const normalized = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_NAME_LENGTH)
    return normalized || DEFAULT_INBOX_NODE_NAME
}

function normalizeEntry(entry) {
    const text = normalizeText(typeof entry === 'string' ? entry : entry?.text)
    if (!text) return null

    const id = typeof entry === 'object' && entry?.id && entry.id !== 'root'
        ? String(entry.id)
        : createEntryId()
    const createdAt = typeof entry === 'object' && Number.isFinite(entry?.createdAt)
        ? entry.createdAt
        : Date.now()

    return { id, text, createdAt }
}

function readQueue() {
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
    return parsed.map(normalizeEntry).filter(Boolean)
}

function writeQueue(items) {
    if (!items.length) return store.inboxQueue.del()
    return store.inboxQueue.set(JSON.stringify(items))
}

function findInboxNode(name) {
    const root = outline.get('root')
    if (!root) return null

    return root.children.peek()
        .map(id => outline.get(id))
        .find(node => node && node.text.peek() === name) || null
}

export function getNodeName() {
    return normalizeNodeName(store.inboxNodeName.get(DEFAULT_INBOX_NODE_NAME))
}

export function setNodeName(name) {
    const normalized = normalizeNodeName(name)
    store.inboxNodeName.set(normalized)
    return normalized
}

export function enqueue(text) {
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
    let inboxNode = findInboxNode(name)
    if (!inboxNode) {
        inboxNode = outline.addChild('root', { text: name })
    }
    if (!inboxNode) {
        log('[Inbox] Could not create or find the Inbox node')
        return 0
    }

    const remaining = []
    let imported = 0

    for (const entry of queued) {
        const existing = outline.get(entry.id)
        if (existing && existing.parentId === inboxNode.id && existing.text.peek() === entry.text) {
            imported++
            continue
        }

        let added = outline.addChild(inboxNode.id, {
            id: entry.id,
            text: entry.text
        })

        // An extremely unlikely ID collision can occur if a queue entry's ID
        // already belongs to another document node. Use a fresh ID rather than
        // leaving that item permanently stuck in the queue.
        if (!added) {
            added = outline.addChild(inboxNode.id, {
                id: createEntryId(),
                text: entry.text
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
    getNodeName,
    setNodeName,
    enqueue,
    pendingCount,
    pendingItems,
    clear,
    reconcile
}
