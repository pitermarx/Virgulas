import { computed } from '@preact/signals'
import outline from './outline.js'

// Returns today as "YYYY-MM-DD" in local time (no timezone shift)
export function todayISO() {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

// Returns the number of calendar days between dueDate and today.
// Negative = overdue, 0 = today, positive = future.
export function daysFromToday(dueDateISO) {
    if (!dueDateISO) return null
    const today = todayISO()
    const a = new Date(today + 'T00:00:00')
    const b = new Date(dueDateISO + 'T00:00:00')
    return Math.round((b - a) / 86400000)
}

// Returns a human-readable label for a due date badge.
export function dueDateLabel(dueDateISO) {
    const days = daysFromToday(dueDateISO)
    if (days === null) return ''
    if (days < -1) return `${Math.abs(days)} days ago`
    if (days === -1) return 'Yesterday'
    if (days === 0) return 'Today'
    if (days === 1) return 'Tomorrow'
    if (days <= 7) return `In ${days} days`
    // Format as "Jun 15"
    const d = new Date(dueDateISO + 'T00:00:00')
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Returns the CSS class suffix for a due date: 'overdue' | 'today' | 'soon' | 'future'
export function dueDateStatus(dueDateISO, done) {
    if (done === true) return 'done'
    const days = daysFromToday(dueDateISO)
    if (days === null) return 'future'
    if (days < 0) return 'overdue'
    if (days === 0) return 'today'
    if (days <= 7) return 'soon'
    return 'future'
}

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
// Returns { overdue, today, soon, upcoming, someday, done } arrays, each containing
// { id, text, dueDate, done, breadcrumb } items. Re-evaluated whenever any task signal changes.
export const groupedTasks = computed(() => {
    // Access outline.version to subscribe to all outline changes
    void outline.version.value

    const tasks = outline.getAllTasks()
    const today = todayISO()

    const groups = { overdue: [], today: [], soon: [], upcoming: [], someday: [], done: [] }

    for (const node of tasks) {
        const peek = node.peek()
        const item = {
            id: peek.id,
            text: peek.text,
            dueDate: peek.dueDate,
            done: peek.done,
            breadcrumb: breadcrumb(peek.id),
        }
        if (peek.done === true) {
            groups.done.push(item)
            continue
        }
        const dd = peek.dueDate
        if (!dd) {
            groups.someday.push(item)
            continue
        }
        const days = daysFromToday(dd)
        if (days < 0) groups.overdue.push(item)
        else if (days === 0) groups.today.push(item)
        else if (days <= 7) groups.soon.push(item)
        else groups.upcoming.push(item)
    }

    // Sort done by lastModified descending
    groups.done.sort((a, b) => {
        const na = outline.get(a.id)
        const nb = outline.get(b.id)
        return (nb?.lastModified ?? 0) - (na?.lastModified ?? 0)
    })

    return groups
})

// Count of urgent tasks (overdue + today, pending only)
export const urgentTaskCount = computed(() => {
    const g = groupedTasks.value
    return g.overdue.length + g.today.length
})
