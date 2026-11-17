// The toolbars: the status bar, the main toolbar with search and breadcrumbs,
// and the static keyboard-shortcuts modal handlers.

import { html } from 'htm/preact'
import { signal } from '@preact/signals'
import outline from '../js/outline.js'
import persistence, { localSaveFailed } from '../js/persistence.js'
import { renderBlockMarkdown } from '../js/markdown.js'
import { isMobile } from '../js/utils.js'
import { zoomIn, handleSearchKeyDown, enterSearchMode, toggleSearchMode, tasksPanelOpen, optionsOpen } from '../js/shortcuts.js'
import { searchQuery, searchResults, searchResultIndex, currentSearchMatchId, resetSearchNavigation } from '../js/search.js'
import { syncStatus } from '../js/syncEngine.js'
import { hasOverdueTasks } from '../js/tasks.js'
import { modeLabel } from '../js/modes.js'
import { focus, focusType, focusMe } from '../js/focus.js'
import { handleInteractiveMarkdownClick } from './outline.js'

function openModal(id: string) {
  const modal = document.getElementById(id)
  if (modal) modal.style.display = ''
}

function closeModals(event: Event) {
  const target = event.target as Element | null
  if (!target?.classList) return
  const isOverlay = target.classList.contains('modal-overlay')
  const isClose = target.classList.contains('modal-close')
  if (!isOverlay && !isClose) return
  document.querySelectorAll('.modal-overlay').forEach((modal) => {
    (modal as HTMLElement).style.display = 'none'
  })
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    closeModals(event)
  })
}
// Sync body class for wide-screen side-by-side task panel layout

if (isMobile && typeof window !== 'undefined' && window.visualViewport) {
    let lastKeyboardInset = -1
    let insetUpdateQueued = false

    const updateKeyboardInset = () => {
        insetUpdateQueued = false
        const vv = window.visualViewport
        if (!vv) return
        const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        if (keyboardHeight === lastKeyboardInset) return
        lastKeyboardInset = keyboardHeight
        document.documentElement.style.setProperty('--keyboard-inset', keyboardHeight + 'px')
    }

    const queueInsetUpdate = () => {
        if (insetUpdateQueued) return
        insetUpdateQueued = true
        window.requestAnimationFrame(updateKeyboardInset)
    }

    window.visualViewport.addEventListener('resize', queueInsetUpdate)
    queueInsetUpdate()
}

const SYNC_LABELS: Record<string, string> = {
    synced: 'Synced',
    syncing: 'Syncing',
    unsynced: 'Not synced',
    error: 'Sync error',
    offline: 'Offline',
    'save-failed': 'Not saved'
}

// a11y-03: every state has its own glyph, so colour is never the only cue.
function syncIcon(state: string) {
    const svg = (children: any) => html`<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`
    switch (state) {
        case 'synced':
            return svg(html`<path d="M2 6.4l2.4 2.4L10 3.2" />`)
        case 'syncing':
            return svg(html`<path d="M9.7 4.3A4 4 0 0 0 2.6 5.6" /><path d="M2.5 2.9v2.7h2.7" /><path d="M2.3 7.7A4 4 0 0 0 9.4 6.4" /><path d="M9.5 9.1V6.4H6.8" />`)
        case 'unsynced':
            return svg(html`<path d="M6 10V2.7" /><path d="M3 5.5l3-3 3 3" />`)
        case 'offline':
            return svg(html`<path d="M3.6 9.2a2.7 2.7 0 0 1-.3-5.4 3.4 3.4 0 0 1 6.4.9 2.2 2.2 0 0 1-.3 4.3" /><path d="M2 10.6L10 1.8" />`)
        default:
            return svg(html`<path d="M6 2.5v4.2" /><path d="M6 9.4v.2" />`)
    }
}

export function StatusToolbar() {
    const mode = persistence.getMode()
    const isMemory = mode === 'memory'
    const remoteIdentity = mode === 'remote' ? persistence.getLastUsername() : ''
    const syncState = localSaveFailed.value
        ? 'save-failed'
        : mode === 'remote'
            ? syncStatus.value
            : (outline.isDirty ? 'unsynced' : 'synced')
    const saveFailedLabel = mode === 'remote' ? 'Not saved locally' : 'Not saved'
    const dotColors: Record<string, string> = {
        synced: 'var(--color-synced)',
        syncing: 'var(--color-syncing)',
        error: 'var(--color-danger)',
        offline: 'var(--color-offline)',
        unsynced: 'var(--color-danger)',
        'save-failed': 'var(--color-danger)'
    }
    const color = dotColors[syncState] || 'var(--color-danger)'
    const label = SYNC_LABELS[syncState] || syncState

    return html`
    <div class="status-toolbar" role="contentinfo">
        <div class="toolbar-actions">
            ${isMobile && html`<button class="toolbar-btn toolbar-btn-search" aria-label="Search" onClick=${() => enterSearchMode(focus)}>Search</button>`}
            <button class="toolbar-btn" onClick=${() => optionsOpen.value = true}>Options</button>
        </div>
        <div class="toolbar-brand">
            ${!isMobile && html`<button class="toolbar-btn" onClick=${() => openModal('keyboard-shortcuts')} aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button>`}
            <button class=${'toolbar-btn toolbar-btn-tasks' + (hasOverdueTasks.value ? ' toolbar-btn-tasks--overdue' : '')} onClick=${() => tasksPanelOpen.value = !tasksPanelOpen.peek()} title="Tasks (Ctrl+Alt+K)" aria-label="Open tasks panel">
                <svg viewBox="-1 -1 18 18" width="14" height="14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="" y="1" width="14" height="14" rx="3" stroke-width="1.5" />
                    <path d="M1 7l5.5 5L18 0" stroke-width="2" />
                </svg>
            </button>
            ${!isMemory && html`<span class="sync-dot sync-indicator" style="color: ${color}" title="Sync: ${syncState}">
                ${syncIcon(syncState)}
                ${!isMobile && html`<span class="sync-label" aria-hidden="true">${label}</span>`}
            </span>`}
            <span class="visually-hidden" role="status">Sync status: ${label}</span>
            ${isMemory
            ? html`<span class="status-memory-badge" title="Document lives in memory only — lost on close">In memory \u2014 not saved</span>`
            : html`<span class="status-mode" title="Current storage mode">${modeLabel(mode)}</span>`}
            ${localSaveFailed.value
            ? html`<span class="status-save-failed" title=${saveFailedLabel}>${saveFailedLabel}</span>`
            : null}
            ${mode === 'remote' && remoteIdentity ? html`<span class="status-user" title=${remoteIdentity}>${remoteIdentity}</span>` : null}
            <span class="status-brand">${isMobile ? "V" : "Virgulas"}</span>
        </div>
    </div>`
}

// `banner` is an optional slot (e.g. the Enable Secure Storage prompt) rendered
// above the breadcrumbs, alongside the search bar.
export function MainToolbar({ banner }: any = {}) {
    let searchBar = null
    if (focusType.value === 'search') {
        const matches = searchResults.value.ids
        const idx = Math.min(searchResultIndex.value, Math.max(matches.length - 1, 0))
        const counterText = matches.length > 0 ? `${idx + 1}/${matches.length}` : ''
        currentSearchMatchId.value = matches[idx] || null

        searchBar = html`<div class="search-bar">
            <div class="search-bar-inner">
                <input placeholder="Search..." ...${focusMe} class="search-input"
                    value=${searchQuery}
                    onInput=${(e: any) => {
            searchQuery.value = e.currentTarget.value
            resetSearchNavigation()
        }}
                    onKeyDown=${(e: any) => handleSearchKeyDown(e, focus)} />
                ${counterText ? html`<span class="search-counter" role="status" aria-live="polite">${counterText}</span>` : null}
                <button class="toolbar-btn" style="font-size: 1.1rem;" onClick=${() => toggleSearchMode(focus)} aria-label="Close search" title="Close search">×</button>
            </div>
        </div>`
    }

    return html`<div class="main-toolbar">
        ${searchBar}
        ${banner || null}
        <${Breadcrumbs} />
    </div>`
}

function BreadcrumbItem({ item, active }: any) {
    return html`<span class="breadcrumb-item ${active ? 'active' : ''}" onClick=${() => zoomIn(item.id, focus)}>
        ${item.parentId ? item.text.value : 'Home'}
    </span>`
}

const zoomDescEditing = signal(false)

function Breadcrumbs() {
    const root = outline.get(outline.zoomId.value)
    if (!root || !root.parentId) return null
    const items: NonNullable<ReturnType<typeof outline.get>>[] = []
    let current: NonNullable<ReturnType<typeof outline.get>> | undefined = root
    while (current) {
        items.unshift(current)
        current = current.parentId ? outline.get(current.parentId) : undefined
    }
    const descText = root.description.value || '';
    const isEditing = zoomDescEditing.value;

    function startEditing(e: any) {
        if (handleInteractiveMarkdownClick(e)) return
        zoomDescEditing.value = true
        focus.Id.value = null
        focus.Type.value = null
        e.stopPropagation()
    }
    function stopEditing() {
        zoomDescEditing.value = false
    }

    return html`<div class="breadcrumbs">
        ${items.map((item, index) => html`<${BreadcrumbItem} item=${item} active=${index === items.length - 1} />`)}
    </div>
    <div class="zoom-description-area">
        ${isEditing
            ? html`<textarea
                ...${focusMe}
                class="zoom-desc-textarea"
                placeholder="Add a description..."
                rows=${descText.split('\n').length || 1}
                value=${root.description}
                onInput=${(e: any) => outline.update(root.id, { description: e.currentTarget.value })}
                onBlur=${stopEditing}
                onKeyDown=${(e: any) => {
                    if (e.key === 'Escape') {
                        stopEditing()
                        focus.Id.value = null
                        focus.Type.value = null
                        document.body.focus()
                        e.preventDefault()
                        e.stopPropagation()
                        return
                    }
                    // Keep native textarea behavior and avoid bubbling to global shortcuts.
                    e.stopPropagation()
                }}></textarea>`
            : html`<div
                class=${'zoom-desc-display markdown-body' + (!descText ? ' zoom-desc-placeholder' : '')}
                onClick=${startEditing}
                dangerouslySetInnerHTML=${{ __html: descText ? renderBlockMarkdown(descText) : 'Add a description...' }}
                ></div>`
        }
    </div>`
}
