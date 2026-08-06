import { computed } from '@preact/signals'
import outline from './outline.js'
import { parseMeta, isOverdue } from './meta.js'

// Returns ancestor texts for breadcrumb display (up to 2 ancestors, stopping at root).
export function breadcrumb(nodeId) {
    const crumbs = []
    let node = outline.get(nodeId)
    if (!node) return crumbs
    let current = outline.get(node.parentId)
    while (current && current.id !== 'root' && crumbs.length < 2) {
        const t = current.text.peek()
        if (t) crumbs.unshift(t)
        current = outline.get(current.parentId)
    }
    return crumbs
}

// Reactive grouped task list.
// Returns { pending, done } arrays, each containing
// { id, text, done, breadcrumb, due?, overdue? } items.
// Re-evaluated whenever any task signal changes.
export const groupedTasks = computed(() => {
    // Subscribe to structural rebuilds (reset/deserialize) and debounced data changes.
    // structureVersion is required because deserialize can restore the same dataVersion
    // (often 0) inside a batch, which would otherwise leave this computed stale.
    void outline.structureVersion.value
    void outline.version.value

    const tasks = outline.getAllTasks()

    const groups = { pending: [], done: [] }

    for (const node of tasks) {
        const peek = node.peek()
        const { meta, text } = parseMeta(peek.text)
        const item = {
            id: peek.id,
            text,
            done: peek.done,
            breadcrumb: breadcrumb(peek.id),
        }
        if (meta.due) {
            item.due = meta.due
            item.overdue = isOverdue(meta.due)
        }
        if (peek.done === true) {
            groups.done.push(item)
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

    return groups
})

// Count of pending tasks
export const pendingTaskCount = computed(() => groupedTasks.value.pending.length)

// True when any pending task is overdue
export const hasOverdueTasks = computed(() =>
    groupedTasks.value.pending.some(item => item.overdue === true)
)