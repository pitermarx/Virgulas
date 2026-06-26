import { computed } from '@preact/signals'
import outline from './outline.js'

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
// { id, text, done, breadcrumb } items. Re-evaluated whenever any task signal changes.
export const groupedTasks = computed(() => {
    // Access outline.version to subscribe to all outline changes
    void outline.version.value

    const tasks = outline.getAllTasks()
    const groups = { pending: [], done: [] }

    for (const node of tasks) {
        const peek = node.peek()
        const item = {
            id: peek.id,
            text: peek.text,
            done: peek.done,
            breadcrumb: breadcrumb(peek.id),
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

    return groups
})

// Count of pending tasks
export const pendingTaskCount = computed(() => groupedTasks.value.pending.length)
