// The tasks panel: grouped pending/scheduled/done rows and the scheduled window.

import { html } from 'htm/preact'
import { effect, signal } from '@preact/signals'
import outline from '../js/outline.js'
import { store } from '../js/utils.js'
import { zoomIn, tasksPanelOpen } from '../js/shortcuts.js'
import { groupedTasks } from '../js/tasks.js'
import { formatDueDate, daysUntilDue } from '../js/meta.js'
import { focus, requestNodeFocus } from '../js/focus.js'

// Sync body class for wide-screen side-by-side task panel layout
effect(() => { document.body.classList.toggle('tasks-panel-is-open', tasksPanelOpen.value) })

const WIDE_LAYOUT_QUERY = '(min-width: 1160px)'

// True when id is already visible in the current view: it is the zoomed node
// itself, or every ancestor between it and the zoomed node is open.
function isNodeVisibleInZoom(id: string, zoomId: string) {
    if (id === zoomId) return true
    const start = outline.get(id)
    let current = start?.parentId ? outline.get(start.parentId) : undefined
    while (current) {
        if (current.id === zoomId) return true
        if (!current.open.peek()) return false
        current = current.parentId ? outline.get(current.parentId) : undefined
    }
    return false
}

function TaskRow({ item }: any) {
    const node = outline.get(item.id)
    if (!node) return null

    function toggle(e: any) {
        e.stopPropagation()
        outline.checkboxToggleDone(item.id)
    }

    function navigate(e: any) {
        e.stopPropagation()
        const isWide = window.matchMedia(WIDE_LAYOUT_QUERY).matches
        if (!isWide) tasksPanelOpen.value = false
        const zoomId = outline.zoomId.peek()
        if (!isNodeVisibleInZoom(item.id, zoomId)) {
            zoomIn(node!.parentId!, focus)
        }
        requestNodeFocus(item.id, 'text')
    }

    const rowClass = 'task-row' + (item.overdue ? ' task-row--overdue' : '')

    return html`<div class=${rowClass}>
        <button class=${'task-row-check' + (item.done ? ' task-row-check--done' : '')} onClick=${toggle} aria-label=${item.done ? 'Mark undone' : 'Mark done'} aria-pressed=${item.done}>
            <svg viewBox="0 0 16 16" width="14" height="14">
                ${item.done
            ? html`<rect x="1" y="1" width="14" height="14" rx="3" fill="var(--color-accent-primary)"/><path d="M4 8l2.5 2.5L12 5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
            : html`<rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="var(--color-text-faint)" stroke-width="1.5"/>`
        }
            </svg>
        </button>
        <div class="task-row-body" onClick=${navigate}>
            <span class=${'task-row-text' + (item.done ? ' task-row-text--done' : '')}>${item.text || html`<em style="opacity:0.5">Untitled</em>`}</span>
            ${(item.due || item.rec) && html`<span class="task-row-meta">
                ${item.due && html`<span class=${'task-row-due' + (item.overdue ? ' task-row-due--overdue' : '')}>${formatDueDate(item.due)}</span>`}
                ${item.rec && html`<span class="task-row-rec" title="Recurs every ${item.rec}">↻${item.rec}</span>`}
            </span>`}
            ${item.breadcrumb.length > 0 && html`<span class="task-row-breadcrumb">${item.breadcrumb.join(' › ')}</span>`}
        </div>
    </div>`
}

// Persistent per-group expansion state: survives rerenders
const _groupExpanded = Object.create(null)
function groupExpandedSignal(title: string, defaultVal: any) {
    if (!_groupExpanded[title]) _groupExpanded[title] = signal(defaultVal)
    return _groupExpanded[title]
}

function TaskGroup({ title, items, defaultExpanded = true }: any) {
    const expanded = groupExpandedSignal(title, defaultExpanded)
    if (items.length === 0) return null
    return html`<div class="tasks-group">
        <button class="tasks-group-header" onClick=${() => expanded.value = !expanded.peek()}>
            <span class="tasks-group-toggle">${expanded.value ? '▼' : '▶'}</span>
            <span class="tasks-group-title">${title}</span>
            <span class="tasks-group-count">${items.length}</span>
        </button>
        ${expanded.value && html`<div class="tasks-group-items">
            ${items.map((item: any) => html`<${TaskRow} key=${item.id} item=${item} />`)}
        </div>`}
    </div>`
}

// Scheduled group windows: how many days out to show by default (persisted).
const SCHEDULED_WINDOW_OPTIONS = [3, 7, 30, Infinity]
const scheduledWindowDays = signal(Number(store.scheduledWindow.get('3')) || 3)

function setScheduledWindow(days: number) {
    scheduledWindowDays.value = days
    store.scheduledWindow.set(String(days))
}

function windowLabel(days: number) {
    return days === Infinity ? 'All' : `${days}d`
}

function ScheduledTaskGroup({ items, defaultExpanded = true }: any) {
    const expanded = groupExpandedSignal('Scheduled', defaultExpanded)
    if (items.length === 0) return null
    const windowDays = scheduledWindowDays.value
    const visible = items.filter((item: any) => (daysUntilDue(item.due) ?? 0) <= windowDays)
    const hiddenCount = items.length - visible.length
    return html`<div class="tasks-group">
        <button class="tasks-group-header" onClick=${() => expanded.value = !expanded.peek()}>
            <span class="tasks-group-toggle">${expanded.value ? '▼' : '▶'}</span>
            <span class="tasks-group-title">Scheduled</span>
            <span class="tasks-group-count">${visible.length}</span>
        </button>
        ${expanded.value && html`<div class="tasks-group-items">
            <div class="tasks-scheduled-filter">
                ${SCHEDULED_WINDOW_OPTIONS.map(days => html`<button
                    class=${'tasks-window-btn' + (windowDays === days ? ' tasks-window-btn--active' : '')}
                    onClick=${() => setScheduledWindow(days)}>${windowLabel(days)}</button>`)}
            </div>
            ${visible.map((item: any) => html`<${TaskRow} key=${item.id} item=${item} />`)}
            ${hiddenCount > 0 && html`<div class="tasks-scheduled-hidden">${hiddenCount} more beyond ${windowLabel(windowDays)}</div>`}
        </div>`}
    </div>`
}

export function TasksPanel() {
    if (!tasksPanelOpen.value) return null
    const groups = groupedTasks.value

    function close() { tasksPanelOpen.value = false }

    return html`<div class="tasks-panel-backdrop" onClick=${close}>
        <div class="tasks-panel" role="region" aria-labelledby="tasks-panel-title" tabIndex=${-1} onClick=${(e: any) => e.stopPropagation()}>
            <div class="tasks-panel-header">
                <span class="tasks-panel-title" id="tasks-panel-title">Tasks</span>
                <button class="tasks-panel-close" onClick=${close} aria-label="Close tasks panel">×</button>
            </div>
            <div class="tasks-panel-body">
                <${TaskGroup} title="Pending" items=${groups.pending} defaultExpanded=${true} />
                <${ScheduledTaskGroup} items=${groups.scheduled} defaultExpanded=${true} />
                <${TaskGroup} title="Done" items=${groups.done} defaultExpanded=${false} />
                ${groups.pending.length + groups.scheduled.length + groups.done.length === 0
        && html`<div class="tasks-empty">No tasks yet. Press <kbd>Ctrl+Enter</kbd> on any node to make it a task.</div>`}
            </div>
        </div>
    </div>`
}
