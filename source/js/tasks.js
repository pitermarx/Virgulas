import { computed } from '@preact/signals'
import outline from './outline.js'
import { parseMeta, isOverdue, isFutureDue } from './meta.js'

// Returns ancestor texts for breadcrumb display (up to 2 ancestors), stopping
// at stopId (the current zoom root) or the document root, whichever comes first.
export function breadcrumb(nodeId, stopId = 'root') {
    const crumbs = []
    let node = outline.get(nodeId)
    if (!node) return crumbs
    let current = outline.get(node.parentId)
    while (current && current.id !== stopId && current.id !== 'root' && crumbs.length < 2) {
        const t = current.text.peek()
        if (t) crumbs.unshift(t)
        current = outline.get(current.parentId)
    }
    return crumbs
}

// True when nodeId is zoomId itself or one of its descendants.
function isWithinZoom(nodeId, zoomId) {
    if (zoomId === 'root') return true
    let current = outline.get(nodeId)
    while (current) {
        if (current.id === zoomId) return true
        current = outline.get(current.parentId)
    }
    return false
}

// Reactive grouped task list, scoped to the current zoom.
// Returns { pending, scheduled, done } arrays, each containing
// { id, text, done, breadcrumb, due?, overdue?, rec? } items.
// - pending: actionable now (no due date, or due date is today or in the past)
// - scheduled: due date is strictly in the future
// - done: completed tasks
// Re-evaluated whenever any task signal, or the zoom, changes.
export const groupedTasks = computed(() => {
    // Subscribe to structural rebuilds (reset/deserialize) and immediate data changes.
    // dirtyWrites increments synchronously on every mutation (update/addChild/deleteNode),
    // so the panel reacts instantly instead of waiting for the debounced version bump.
    // structureVersion is required because deserialize can restore the same dataVersion
    // (often 0) inside a batch, which would otherwise leave this computed stale.
    void outline.structureVersion.value
    void outline.dirtyWrites.value
    const zoomId = outline.zoomId.value

    const tasks = outline.getAllTasks().filter(node => isWithinZoom(node.peek().id, zoomId))

    const groups = { pending: [], scheduled: [], done: [] }

    for (const node of tasks) {
        const peek = node.peek()
        const { meta, text } = parseMeta(peek.text)
        const item = {
            id: peek.id,
            text,
            done: peek.done,
            breadcrumb: breadcrumb(peek.id, zoomId),
        }
        if (meta.due) {
            item.due = meta.due
            item.overdue = isOverdue(meta.due)
        }
        if (meta.rec) {
            item.rec = meta.rec
        }
        if (peek.done === true) {
            groups.done.push(item)
        } else if (item.due && isFutureDue(item.due)) {
            groups.scheduled.push(item)
        } else {
            groups.pending.push(item)
        }
    }

    // Sort done by lastModified descending
    groups.done.sort((a, b) => {
        const na = outline.get(a.id)
        const nb = outline.get(b.id)
        return (nb?.lastModified ?? 0) - (na?.lastModified ?? 0)
    })

    // Sort pending: overdue first, then by due date ascending, then document order.
    groups.pending.sort((a, b) => {
        const aOverdue = a.overdue ? 1 : 0
        const bOverdue = b.overdue ? 1 : 0
        if (aOverdue !== bOverdue) return bOverdue - aOverdue
        if (a.due && b.due) return a.due.localeCompare(b.due)
        if (a.due) return -1
        if (b.due) return 1
        return 0
    })

    // Sort scheduled by due date ascending (soonest first).
    groups.scheduled.sort((a, b) => a.due.localeCompare(b.due))

    return groups
})

// Count of open tasks (pending + scheduled)
export const pendingTaskCount = computed(() => groupedTasks.value.pending.length + groupedTasks.value.scheduled.length)

// True when any pending task is overdue
export const hasOverdueTasks = computed(() =>
    groupedTasks.value.pending.some(item => item.overdue === true)
)