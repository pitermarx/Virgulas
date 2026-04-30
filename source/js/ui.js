import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import outline from "./outline.js"
import persistence from './persistence.js';
import { renderInlineMarkdown } from './markdown.js';
import { log, isMobile } from './utils.js';
import { keydown, zoomIn, toggleSearchMode, handleSearchKeyDown, enterSearchMode } from './shortcuts.js';
import { searchQuery, searchResultIndex, currentSearchMatchId, flatMatches, getFirstClosedParent, resetSearchNavigation } from './search.js';
import { syncStatus, pendingConflicts, pendingMergedDoc, pendingConflictResolutions, resolveConflicts } from './sync.js';
import { appVersion, devPanelOpen, devSync, devCrypto, devOutline, devPersistence, devStorage, refreshStorageQuota } from './devtools.js';

const focusId = signal(null)
const focusType = signal(null)
const selectedIds = signal([])
const focus = { Id: focusId, Type: focusType, SelectedIds: selectedIds }
const FOCUS_TRANSFER_WINDOW_MS = 450
const BLUR_SETTLE_MS = 75
let pendingFocusTransfer = null

function getNodeIdFromElement(el) {
    return el?.closest?.('.node-content')?.getAttribute('data-node-id') || null
}

function markFocusTransfer(id, type) {
    pendingFocusTransfer = {
        id: String(id),
        type,
        expiresAt: Date.now() + FOCUS_TRANSFER_WINDOW_MS
    }
}

function requestNodeFocus(id, type) {
    markFocusTransfer(id, type)
    focusId.value = id
    focusType.value = type
}

function hasActiveTransferForOtherNode(id) {
    if (!pendingFocusTransfer) return false
    if (Date.now() > pendingFocusTransfer.expiresAt) {
        pendingFocusTransfer = null
        return false
    }
    return pendingFocusTransfer.id !== String(id)
}

function clearTransferForElement(el) {
    if (!pendingFocusTransfer) return
    const nodeId = getNodeIdFromElement(el)
    if (nodeId && nodeId === pendingFocusTransfer.id) {
        pendingFocusTransfer = null
    }
}

function focusElement(el) {
    if (!el) return
    if (document.activeElement !== el) {
        try {
            el.focus({ preventScroll: true })
        } catch {
            el.focus()
        }
    }
    clearTransferForElement(el)
}

function scheduleBlurClear(id, type) {
    setTimeout(() => {
        const activeNodeId = getNodeIdFromElement(document.activeElement)
        if (activeNodeId === String(id)) return
        if (hasActiveTransferForOtherNode(id)) return
        if (focusId.value === id && focusType.value === type) {
            focusId.value = null
            focusType.value = null
        }
    }, BLUR_SETTLE_MS)
}

const focusMe = { ref: focusElement }

function openSearchWithQuery(query) {
    const nextQuery = String(query || '').trim()
    if (!nextQuery) return
    enterSearchMode(focus)
    searchQuery.value = nextQuery
    resetSearchNavigation()
}

function handleInteractiveMarkdownClick(e) {
    if (!(e?.target instanceof Element)) return false

    const tokenTarget = e.target.closest('[data-search-token]')
    if (tokenTarget) {
        const token = tokenTarget.getAttribute('data-search-token')
        if (!token) return false
        e.preventDefault()
        e.stopPropagation()
        openSearchWithQuery(token)
        return true
    }

    const linkTarget = e.target.closest('a[href]')
    if (linkTarget) {
        linkTarget.setAttribute('target', '_blank')
        linkTarget.setAttribute('rel', 'noopener noreferrer')
        e.stopPropagation()
        return true
    }

    return false
}

// ── Mobile keyboard-aware status bar ─────────────────────────────────────────
// When the virtual keyboard appears on mobile, the visible viewport shrinks.
// We apply a dynamic bottom inset to the status toolbar so it stays visible
// above the keyboard. Desktop behavior is unchanged.
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

const fadedText = "color: var(--color-text-muted);"


const hasClosedChildrenBullet = html`<circle cx="25" cy="25" r="10" fill="none" stroke="currentColor" stroke-width="5"/>`
const NormalBullet = html`<circle cx="25" cy="25" r="10" fill="currentColor"/>`
const hasOpenChildrenBullet = html`<g><circle cx="25" cy="25" r="10" fill="currentColor"/><circle cx="25" cy="25" r="18" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.35"/></g>`
const SWIPE_MIN_DISTANCE_PX = 56
const SWIPE_AXIS_RATIO = 1.35
const MOBILE_SEARCH_SCROLL_MIN_PX = 72
const MOBILE_SEARCH_SCROLL_AXIS_RATIO = 1.2

function firstTouch(list) {
    if (!list || list.length === 0) return null
    return list[0]
}

function isEditingNodeText() {
    return focusType.value === 'text' || focusType.value === 'description'
}

function isSearchGestureBlockedTarget(target) {
    if (!(target instanceof Element)) return false
    return !!target.closest('input, textarea, button, a, .bullet, .collapse-toggle, .search-bar')
}

if (isMobile && typeof window !== 'undefined') {
    let gestureActive = false
    let gestureBlocked = false
    let startX = 0
    let startY = 0

    function resetGesture() {
        gestureActive = false
        gestureBlocked = false
        startX = 0
        startY = 0
    }

    function shouldBlockSearchGesture(target) {
        return focusType.value === 'search' || isEditingNodeText() || isSearchGestureBlockedTarget(target)
    }

    function onTouchStart(e) {
        const touch = firstTouch(e.touches)
        if (!touch || e.touches.length !== 1) {
            resetGesture()
            return
        }

        gestureActive = true
        gestureBlocked = shouldBlockSearchGesture(e.target)
        startX = touch.clientX
        startY = touch.clientY
    }

    function onTouchEnd(e) {
        if (!gestureActive) return

        const endTouch = firstTouch(e.changedTouches) || firstTouch(e.touches)
        const deltaX = endTouch ? (endTouch.clientX - startX) : 0
        const deltaY = endTouch ? (endTouch.clientY - startY) : 0
        const blocked = gestureBlocked || shouldBlockSearchGesture(e.target)

        resetGesture()

        if (!endTouch || blocked) return

        const absX = Math.abs(deltaX)
        const absY = Math.abs(deltaY)
        const isUpward = deltaY <= -MOBILE_SEARCH_SCROLL_MIN_PX
        const isVertical = absY > absX * MOBILE_SEARCH_SCROLL_AXIS_RATIO

        if (!isUpward || !isVertical) return

        enterSearchMode(focus)
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', resetGesture, { passive: true })
}

function isSwipeGesture(deltaX, deltaY) {
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)
    return absX >= SWIPE_MIN_DISTANCE_PX && absX > absY * SWIPE_AXIS_RATIO
}

function isSwipeBlockedTarget(target) {
    if (!(target instanceof Element)) return false
    return !!target.closest('input, textarea, a, button, .bullet, .collapse-toggle')
}

function NodeDesc({ node }) {
    const { description, id } = node.value // subscribe to changes on node
    const focusDesc = e => {
        if (handleInteractiveMarkdownClick(e)) return
        requestNodeFocus(id, 'description')
        e.stopPropagation()
    }

    if (focusId.value === id && focusType.value === 'description') {
        function onBlur() {
            scheduleBlurClear(id, 'description')
        }
        function autosizeAndFocus(el) {
            focusElement(el)
            if (!el) return
            el.style.height = 'auto'
            el.style.height = el.scrollHeight + 'px'
        }
        return html`<div class="node-description" onClick=${focusDesc}>
            <textarea
                ref=${autosizeAndFocus} type="text"
                rows="1"
                class="node-desc-textarea" placeholder="Add description..." value=${description} focused
                onBlur=${onBlur}
                onpaste=${e => {
                // Description always uses plain-text paste — never routed through VMD parser
                e.preventDefault()
                const text = e.clipboardData.getData('text/plain')
                const target = e.currentTarget
                const start = target.selectionStart
                const end = target.selectionEnd
                const current = target.value
                const next = current.substring(0, start) + text + current.substring(end)
                outline.update(id, { description: next })
                // Restore caret position after Preact re-render
                requestAnimationFrame(() => {
                    target.selectionStart = target.selectionEnd = start + text.length
                })
            }}
                onInput=${e => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = el.scrollHeight + 'px'
                outline.update(id, { description: el.value })
            }}>
            </textarea></div>`
    }

    let text = description
    let style = ''
    if (!text && focusId.value === id && isMobile) {
        text = 'Add description...'
        style = fadedText
    }

    return html`<div class="node-description" onClick=${focusDesc}>
        <div class="node-desc-md" style=${style} dangerouslySetInnerHTML=${{ __html: style ? text : renderInlineMarkdown(text) }}></div></div>`
}

function NodeText({ node }) {
    const { text, id } = node.value // subscribe to changes on node
    if (focusId.value === id && focusType.value === 'text') {
        function onBlur() {
            scheduleBlurClear(id, 'text')
        }
        return html`<input
            ...${focusMe} type="text" onpaste=${e => {
                const text = e.clipboardData.getData('text/plain')
                const lines = text.split(/\r?\n/).filter(l => l.trim())
                // Single-line paste without a leading bullet marker → native paste
                const isSingleLine = lines.length <= 1
                const hasBullet = lines.length > 0 && /^\s*[-+]/.test(lines[0])
                if (isSingleLine && !hasBullet) {
                    // Allow the browser to handle it natively (insert at caret)
                    return
                }
                e.preventDefault()
                outline.setVMD(text, id)
            }}
            class="node-text-input" placeholder="Type here..." value=${text}
            onBlur=${onBlur} onInput=${e => outline.update(id, { text: e.currentTarget.value })} />`
    }

    return html`<div
        class="node-text-md"
        style=${text ? '' : fadedText}
        dangerouslySetInnerHTML=${{ __html: text ? renderInlineMarkdown(text) : '&nbsp;' }}
        onClick=${e => {
            if (e.target === e.currentTarget) {
                requestNodeFocus(id, 'text')
                e.stopPropagation()
                e.preventDefault()
            }
        }}></div>`
}

function NodeBody({ node }) {
    const { id, children, open } = node.value // subscribe to changes on node
    const hasChildren = children.length > 0
    const isFocused = focusId.value === id
    const isSelected = selectedIds.value.includes(id)
    const swipeState = {
        active: false,
        startX: 0,
        startY: 0
    }

    function resetSwipeState() {
        swipeState.active = false
        swipeState.startX = 0
        swipeState.startY = 0
    }

    function focusTextIfOnlyClickedThisElement(e) {
        if (handleInteractiveMarkdownClick(e)) return
        if (e.target.closest('.bullet, .collapse-toggle')) return
        selectedIds.value = []
        requestNodeFocus(id, 'text')
        e.stopPropagation()
    }

    function handleTouchStart(e) {
        if (!isMobile) return
        if (isSwipeBlockedTarget(e.target)) {
            resetSwipeState()
            return
        }
        if (e.touches?.length !== 1) {
            resetSwipeState()
            return
        }

        const touch = firstTouch(e.touches)
        if (!touch) {
            resetSwipeState()
            return
        }

        swipeState.active = true
        swipeState.startX = touch.clientX
        swipeState.startY = touch.clientY
    }

    function handleTouchMove(e) {
        if (!isMobile || !swipeState.active) return

        const touch = firstTouch(e.touches)
        if (!touch) {
            resetSwipeState()
            return
        }

        const deltaX = touch.clientX - swipeState.startX
        const deltaY = touch.clientY - swipeState.startY
        // Prevent accidental page panning only when movement is clearly horizontal.
        if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
            e.preventDefault()
        }
    }

    function handleTouchEnd(e) {
        if (!isMobile || !swipeState.active) return

        const touch = firstTouch(e.changedTouches) || firstTouch(e.touches)
        const startX = swipeState.startX
        const startY = swipeState.startY
        resetSwipeState()
        if (!touch) return

        const deltaX = touch.clientX - startX
        const deltaY = touch.clientY - startY
        if (!isSwipeGesture(deltaX, deltaY)) return

        e.preventDefault()
        e.stopPropagation()

        if (deltaX > 0) {
            outline.indent(id)
        } else {
            outline.outdent(id)
        }
    }

    function handleTouchCancel() {
        resetSwipeState()
    }

    return html`
    <div class="node-content ${isFocused ? 'node-focused' : ''} ${isSelected ? 'node-selected' : ''}" data-node-id=${id}
        onClick=${focusTextIfOnlyClickedThisElement}
        onTouchStart=${handleTouchStart}
        onTouchMove=${handleTouchMove}
        onTouchEnd=${handleTouchEnd}
        onTouchCancel=${handleTouchCancel}>
        <span class="bullet" draggable="true" onClick=${() => zoomIn(id, focus)}>
            <svg viewBox="0 0 50 50">
                ${hasChildren && !open ? hasClosedChildrenBullet : hasChildren ? hasOpenChildrenBullet : NormalBullet}
            </svg>
        </span>
    <div class="node-body">
        <${NodeText} node=${node} />
        <${NodeDesc} node=${node} />
    </div>
    ${hasChildren && html`<span class="collapse-toggle" onClick=${() => outline.toggleOpen(id)}>${open ? '▼' : '▶'}</span>`}
    </div>
    `
}

function Node({ node, indent = 0 }) {
    const { id, children, open } = node.value // subscribe to changes on node
    const fontSize = indent === 0 ? `var(--text-size-root)` : `var(--text-size-level-${Math.min(indent, 2)})`;

    function toggleOpenIfOnlyClickedThisElement(e) {
        if (e.target === e.currentTarget) {
            outline.toggleOpen(id)
        }
    }
    return html`
    <div key=${id} class="node" style="font-size: ${fontSize};">
        <${NodeBody} node=${node} />
        ${open && children.length ? html`
        <div class="children" onClick=${toggleOpenIfOnlyClickedThisElement}>
            ${children.map(outline.get).filter(c => c).map(child => html`<${Node} node=${child} indent=${indent + 1} />`)}
        </div>` : ''}
    </div>
    `
}

export const rawMode = signal(false)
const rawContent = signal('')
const rawError = signal('')

export function RawEditor() {
    function save() {
        rawError.value = ''
        try {
            outline.setRootVMD(rawContent.value)
            rawMode.value = false
        } catch (error) {
            rawError.value = String(error?.message || 'Invalid VMD document.')
        }
    }
    return html`<div class="raw-view">
        <div class="raw-container">
            <div class="raw-toolbar">
                <h2 class="raw-title">Raw Editor</h2>
                <div class="raw-toolbar-actions">
                    <button class="btn btn-primary" onClick=${save}>Back to Outline</button>
                    <button class="btn btn-secondary" onClick=${() => {
            rawError.value = ''
            rawMode.value = false
        }}>Cancel</button>
                </div>
            </div>
            ${rawError.value ? html`<div class="form-error">${rawError.value}</div>` : null}
            <textarea class="raw-editor"
                value=${rawContent.value}
                onInput=${e => rawContent.value = e.currentTarget.value}></textarea>
        </div>
    </div>`
}

export const optionsOpen = signal(false)

export function StatusToolbar() {
    const mode = persistence.getMode()
    const isMemory = mode === 'memory'
    const modeLabel = mode === 'remote' ? 'Remote' : mode === 'filesystem' ? 'File' : isMemory ? 'Memory' : 'Local'
    const remoteIdentity = mode === 'remote' ? persistence.getLastUsername() : ''
    const syncState = mode === 'remote'
        ? syncStatus.value
        : (outline.isDirty.value ? 'unsynced' : 'synced')
    const dotColors = {
        synced: 'var(--color-synced)',
        syncing: 'var(--color-syncing)',
        error: 'var(--color-danger)',
        offline: 'var(--color-offline)',
        unsynced: 'var(--color-danger)'
    }
    const color = dotColors[syncState] || 'var(--color-danger)'
    return html`
    <div class="status-toolbar">
        <div class="toolbar-actions">
            ${!isMemory && html`<button class="toolbar-btn" onClick=${() => {
            rawError.value = ''
            rawContent.value = outline.getVMD()
            rawMode.value = true
        }}>Raw</button>`}
            ${isMobile && html`<button class="toolbar-btn toolbar-btn-search" aria-label="Search" onClick=${() => enterSearchMode(focus)}>Search</button>`}
            <button class="toolbar-btn" onClick=${() => optionsOpen.value = true}>Options</button>
        </div>
        <div class="toolbar-brand">
            ${!isMobile && html`<button class="toolbar-btn" onclick=${() => openModal('keyboard-shortcuts')}>?</button>`}
            ${!isMemory && html`<span class="sync-dot" style="background-color: ${color};" title="Sync: ${syncState}"></span>`}
            ${isMemory
            ? html`<span class="status-memory-badge" title="Document lives in memory only — lost on close">In memory \u2014 not saved</span>`
            : html`<span class="status-mode" title="Current storage mode">${modeLabel}</span>`}
            ${mode === 'remote' && remoteIdentity ? html`<span class="status-user" title=${remoteIdentity}>${remoteIdentity}</span>` : null}
            <span class="status-brand">${isMobile ? "V" : "Virgulas"}</span>
        </div>
    </div>`
}

export function MainToolbar() {
    if (focusType.value === 'search') {
        const results = searchQuery.value ? outline.search(searchQuery.value) : null
        const matches = results ? flatMatches(results) : []
        const idx = Math.min(searchResultIndex.value, Math.max(matches.length - 1, 0))
        const counterText = matches.length > 0 ? `${idx + 1}/${matches.length}` : ''
        currentSearchMatchId.value = matches[idx] || null

        return html`<div class="main-toolbar">
            <${Breadcrumbs} />
            <div class="search-bar">
                <div class="search-bar-inner">
                    <input placeholder="Search..." ...${focusMe} class="search-input"
                        value=${searchQuery}
                        onInput=${e => {
                searchQuery.value = e.currentTarget.value
                resetSearchNavigation()
            }}
                        onKeyDown=${e => handleSearchKeyDown(e, focus)} />
                    ${counterText ? html`<span class="search-counter">${counterText}</span>` : null}
                    <button class="toolbar-btn" style="font-size: 1.1rem;" onClick=${() => toggleSearchMode(focus)}>×</button>
                </div>
            </div>
        </div>`
    }

    return html`<div class="main-toolbar">
        <${Breadcrumbs} />
    </div>`
}

function BreadcrumbItem({ item, active }) {
    return html`<span class="breadcrumb-item ${active ? 'active' : ''}" onClick=${() => zoomIn(item.id, focus)}>
        ${item.parentId ? item.text.value : 'Home'}
    </span>`
}

const zoomDescEditing = signal(false)

function Breadcrumbs() {
    const root = outline.get(outline.zoomId.value)
    if (!root || !root.parentId) return null
    const items = []
    let current = root
    while (current) {
        items.unshift(current)
        current = outline.get(current.parentId)
    }
    const descText = root.description.value || '';
    const isEditing = zoomDescEditing.value;

    function startEditing(e) {
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
                onInput=${e => outline.update(root.id, { description: e.currentTarget.value })}
                onBlur=${stopEditing}
                onKeyDown=${e => {
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
                class=${'zoom-desc-display' + (!descText ? ' zoom-desc-placeholder' : '')}
                onClick=${startEditing}
                dangerouslySetInnerHTML=${{ __html: descText ? renderInlineMarkdown(descText) : 'Add a description...' }}
                ></div>`
        }
    </div>`
}


export function Outline() {
    const root = outline.get(outline.zoomId.value) // subscribe to changes on root node and zoomed node
    if (focusType.value === 'search' && searchQuery.value) {
        const searchResults = outline.search(searchQuery.value)
        return html`<div class="outliner search-results" key="search-results">
            ${searchResults.children.map(result => html`<${SearchNode} node=${result} />`)}
        </div>`
    }

    const children = root.children.value.map(outline.get).filter(c => c)
    if (children.length === 0) {
        function createFirstNode() {
            const n = outline.addChild(root.id, { text: '' })
            focusId.value = n.id
            focusType.value = 'text'
        }
        return html`<div class="outliner" key="${root.id}-root">
            <div class="empty-state" tabIndex="-1"
                onClick=${createFirstNode}
                onKeyDown=${e => { if (e.key === 'Enter') { createFirstNode(); e.preventDefault(); e.stopPropagation() } }}>
                Press Enter to start writing…
            </div>
        </div>`
    }

    return html`
    <div class="outliner" key="${root.id}-root">
        ${children.map(node => html`<${Node} node=${node} />`)}
    </div>`
}

function SearchNode({ node, indent = 0 }) {
    const { text, description, id, children, isMatch } = node
    const fontSize = indent === 0 ? `var(--text-size-root)` : `var(--text-size-level-${Math.min(indent, 2)})`;
    const isCurrent = currentSearchMatchId.value === id
    const style = isCurrent
        ? 'background-color: var(--color-search-current);'
        : isMatch ? 'background-color: var(--color-search-match);' : ''
    function clickResult(e) {
        const zoomTarget = getFirstClosedParent(id)
        if (!zoomTarget) return
        currentSearchMatchId.value = id
        zoomIn(zoomTarget, focus)
        focus.Id.value = id
        focus.Type.value = 'text'
        e.stopPropagation()
    }
    return html`<div key=${id} class="node" style="font-size: ${fontSize};">
        <div class="node-content" data-node-id=${id} style=${style}>
            <span class="bullet" draggable="true" onClick=${() => zoomIn(id, focus)}>
                <svg viewBox="0 0 50 50">${NormalBullet}</svg>
            </span>
            <div class="node-body" onClick=${clickResult}>
                <div class="node-text-md">${text || " "}</div>
                <div class="node-description">
                    <div class="node-desc-md">${description}</div>
                </div>
            </div>
        </div>
        <div class="children">
            ${children.map(child => html`<${SearchNode} node=${child} indent=${indent + 1} />`)}
        </div>
    </div>`
}

function syncZoomFromHash() {
    const hashId = window.location.hash.replace('#', '')
    if (!hashId) {
        outline.zoomIn('root')
        return
    }

    const target = outline.get(hashId)
    if (target) {
        outline.zoomIn(hashId)
        return
    }

    // Ignore unknown hashes by showing root.
    outline.zoomIn('root')
}

if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', syncZoomFromHash)
}

document.onkeydown = keydown(focus)

function formatBytes(bytes) {
    if (!bytes) return '0 B'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function DeveloperPanel() {
    if (!devPanelOpen.value) return null

    const focusedNode = focusId.value ? outline.get(focusId.value) : null
    const focusedNodeRaw = focusedNode ? JSON.stringify(focusedNode.peek(), null, 2) : 'none'
    const stats = outline.getStats()

    // Refresh storage quota each time the panel is rendered open
    refreshStorageQuota()

    return html`<div class="dev-panel">
        <div class="dev-panel-header">Developer Panel <button class="dev-panel-close" onClick=${() => devPanelOpen.value = false}>×</button></div>
        <div class="dev-panel-grid">
            <section class="dev-panel-section">
                <h4>Outline</h4>
                <dl>
                    <dt>Nodes</dt><dd>${stats.nodeCount}</dd>
                    <dt>Max depth</dt><dd>${stats.maxDepth}</dd>
                    <dt>Words</dt><dd>${stats.wordCount}</dd>
                    <dt>Chars</dt><dd>${stats.charCount}</dd>
                    <dt>Open w/ children</dt><dd>${stats.openCount}</dd>
                    <dt>Collapsed</dt><dd>${stats.collapsedCount}</dd>
                </dl>
            </section>
            <section class="dev-panel-section">
                <h4>App</h4>
                <dl>
                    <dt>Version</dt><dd class="dev-app-version">${appVersion.value}</dd>
                </dl>
            </section>
            <section class="dev-panel-section">
                <h4>Focus / Zoom / Search</h4>
                <dl>
                    <dt>Focus ID</dt><dd>${focusId.value || '—'}</dd>
                    <dt>Focus type</dt><dd>${focusType.value || '—'}</dd>
                    <dt>Zoom ID</dt><dd>${outline.zoomId.value}</dd>
                    <dt>Search</dt><dd>${searchQuery.value ? '"' + searchQuery.value + '"' : '—'}</dd>
                    <dt>Hash applied</dt><dd>${devPersistence.hashApplied.value ? 'yes' : 'no'}</dd>
                    <dt>Unlock mode</dt><dd>${devPersistence.unlockMode.value || persistence.getMode()}</dd>
                    <dt>Unlock ms</dt><dd>${devPersistence.unlockDurationMs.value || '—'}</dd>
                </dl>
            </section>
            <section class="dev-panel-section">
                <h4>Sync</h4>
                <dl>
                    <dt>Status</dt><dd>${syncStatus.value}</dd>
                    <dt>Last sync</dt><dd>${devSync.lastSyncAt.value ? new Date(devSync.lastSyncAt.value).toLocaleTimeString() : '—'}</dd>
                    <dt>Last sync ms</dt><dd>${devSync.lastSyncDurationMs.value || '—'}</dd>
                    <dt>Retries</dt><dd>${devSync.retryCount.value}</dd>
                    <dt>Last error</dt><dd>${devSync.lastError.value || '—'}</dd>
                    <dt>Conflicts seen</dt><dd>${devSync.conflictCount.value}</dd>
                    <dt>Poll runs</dt><dd>${devSync.pollRunCount.value}</dd>
                </dl>
            </section>
            <section class="dev-panel-section">
                <h4>Crypto</h4>
                <dl>
                    <dt>Last encrypt</dt><dd>${devCrypto.lastEncryptMs.value ? devCrypto.lastEncryptMs.value + ' ms' : '—'}</dd>
                    <dt>Last decrypt</dt><dd>${devCrypto.lastDecryptMs.value ? devCrypto.lastDecryptMs.value + ' ms' : '—'}</dd>
                </dl>
            </section>
            <section class="dev-panel-section">
                <h4>Storage</h4>
                <dl>
                    <dt>Used</dt><dd>${formatBytes(devStorage.usageBytes.value)}</dd>
                    <dt>Quota</dt><dd>${formatBytes(devStorage.quotaBytes.value)}</dd>
                </dl>
            </section>
            <section class="dev-panel-section dev-panel-section-full">
                <h4>Focused node JSON</h4>
                <pre class="dev-panel-json">${focusedNodeRaw}</pre>
            </section>
        </div>
    </div>`
}

// Keep DebugPanel as an alias for backwards compat in tests
export function DebugPanel() {
    return DeveloperPanel()
}

// ── Conflict resolution modal ─────────────────────────────────────────────────

export function ConflictModal() {
    const conflicts = pendingConflicts.value
    if (conflicts.length === 0) return null

    function choose(nodeId, field, side) {
        const m = new Map(pendingConflictResolutions.peek())
        m.set(`${nodeId}::${field}`, side)
        pendingConflictResolutions.value = m
    }

    function useAll(side) {
        const m = new Map()
        for (const c of conflicts) {
            m.set(`${c.nodeId}::${c.field}`, side)
        }
        pendingConflictResolutions.value = m
    }

    function allResolved() {
        const m = pendingConflictResolutions.value
        return conflicts.every(c => m.has(`${c.nodeId}::${c.field}`))
    }

    async function apply() {
        if (!allResolved()) return
        const m = pendingConflictResolutions.peek()
        const resList = conflicts.map(c => ({
            nodeId: c.nodeId,
            field: c.field,
            chosenSide: m.get(`${c.nodeId}::${c.field}`)
        }))
        await resolveConflicts(resList)
    }

    function renderValue(field, value) {
        if (field === 'children') {
            const doc = pendingMergedDoc.peek()
            const nodeMap = doc ? new Map(doc.nodes.map(n => [n.id, n])) : new Map()
            const ids = Array.isArray(value) ? value : []
            return html`<ul class="conflict-children-list">
                ${ids.map(id => html`<li>${nodeMap.get(id)?.text || id}</li>`)}
            </ul>`
        }
        return html`<textarea class="conflict-value-textarea" readonly rows="4">${value}</textarea>`
    }

    const fieldLabels = { text: 'Text', description: 'Description', children: 'Children' }

    return html`<div class="modal-overlay conflict-overlay">
        <div class="modal-dialog conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
            <div class="modal-header">
                <h2 id="conflict-title" class="modal-title">Sync conflicts (${conflicts.length})</h2>
            </div>
            <div class="conflict-body">
                ${conflicts.map(c => {
        const key = `${c.nodeId}::${c.field}`
        const chosen = pendingConflictResolutions.value.get(key)
        return html`<div class="conflict-item">
                        <div class="conflict-node-label">
                            <strong>${c.nodeText || '(no text)'}</strong>
                            <span class="conflict-field-label">${fieldLabels[c.field] || c.field}</span>
                        </div>
                        <div class="conflict-sides">
                            <div class=${'conflict-side' + (chosen === 'local' ? ' conflict-side-chosen' : '')}>
                                <div class="conflict-side-header">Local</div>
                                ${renderValue(c.field, c.localValue)}
                                <button class="btn btn-secondary conflict-keep-btn"
                                    onClick=${() => choose(c.nodeId, c.field, 'local')}>
                                    Keep local
                                </button>
                            </div>
                            <div class=${'conflict-side' + (chosen === 'remote' ? ' conflict-side-chosen' : '')}>
                                <div class="conflict-side-header">Remote</div>
                                ${renderValue(c.field, c.remoteValue)}
                                <button class="btn btn-secondary conflict-keep-btn"
                                    onClick=${() => choose(c.nodeId, c.field, 'remote')}>
                                    Keep remote
                                </button>
                            </div>
                        </div>
                    </div>`
    })}
            </div>
            <div class="conflict-footer">
                <button class="btn btn-secondary" onClick=${() => useAll('local')}>Use all local</button>
                <button class="btn btn-secondary" onClick=${() => useAll('remote')}>Use all remote</button>
                <button class="btn btn-primary" disabled=${!allResolved()} onClick=${apply}>Apply</button>
            </div>
        </div>
    </div>`
}
