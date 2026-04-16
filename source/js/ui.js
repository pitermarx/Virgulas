import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import outline from "./outline.js"
import { log, isMobile } from './utils.js';
import { keydown, zoomIn, toggleSearchMode, handleSearchKeyDown } from './shortcuts.js';
import { searchQuery, searchResultIndex, currentSearchMatchId, flatMatches } from './search.js';

const focusId = signal(null)
const focusType = signal(null)
const selectedIds = signal([])
const focus = { Id: focusId, Type: focusType, SelectedIds: selectedIds }
const focusMe = { ref: (el) => el && setTimeout(() => el.focus(), 0) }

const fadedText = "color: var(--color-text-muted);"

function renderInlineMarkdown(text) {
    if (!text) return ''
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    return escaped
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
            const safeSrc = /^https?:\/\//.test(src) ? src : ''
            return safeSrc ? `<img src="${safeSrc}" alt="${alt}">` : (alt || '')
        })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, href) => {
            const safeHref = /^https?:\/\//.test(href) ? href : '#'
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${linkText}</a>`
        })
}


const hasClosedChildrenBullet = html`<circle cx="25" cy="25" r="10" fill="none" stroke="currentColor" stroke-width="5"/>`
const NormalBullet = html`<circle cx="25" cy="25" r="10" fill="currentColor"/>`
const SWIPE_MIN_DISTANCE_PX = 56
const SWIPE_AXIS_RATIO = 1.35

function firstTouch(list) {
    if (!list || list.length === 0) return null
    return list[0]
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
    const lines = description.split('\n')
    const focusDesc = e => {
        focusId.value = id
        focusType.value = 'description'
        e.stopPropagation()
        console.log('Focusing description of node', id)
    }

    if (focusId.value === id && focusType.value === 'description') {
        function onBlur() {
            setTimeout(() => {
                if (focusId.value === id && focusType.value === 'description') {
                    focusId.value = null
                    focusType.value = null
                }
            }, 250);
        }
        return html`<div class="node-description" onClick=${focusDesc}>
            <textarea
                rows=${lines.length || 1} ...${focusMe} type="text"
                class="node-desc-textarea" placeholder="Add description..." value=${description} focused
                onBlur=${onBlur} onInput=${e => outline.update(id, { description: e.currentTarget.value })}>
            </textarea></div>`
    }

    if (lines.length > 2) {
        lines[1] += '\u2026'
    }

    let text = lines.slice(0, 2).join('\n')
    let style = ''
    if (!text && focusId.value === id) {
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
            setTimeout(() => {
                if (focusId.value === id && focusType.value === 'text') {
                    focusId.value = null
                    focusType.value = null
                }
            }, 250);
        }
        return html`<input
            ...${focusMe} type="text" onpaste=${e => {
                e.preventDefault()
                outline.setVMD(e.clipboardData.getData('text/plain'), id)
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
                focusId.value = id
                focusType.value = 'text'
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
        if (e.target === e.currentTarget) {
            selectedIds.value = []
            focusId.value = id
            focusType.value = 'text'
            e.stopPropagation()
        }
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

        selectedIds.value = []
        focusId.value = id
        focusType.value = 'text'

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
                ${hasChildren && !open ? hasClosedChildrenBullet : NormalBullet}
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

export function RawEditor() {
    function save() {
        outline.setRootVMD(rawContent.value)
        rawMode.value = false
    }
    return html`<div class="raw-view">
        <div class="raw-container">
            <div class="raw-toolbar">
                <h2 class="raw-title">Raw Editor</h2>
                <div class="raw-toolbar-actions">
                    <button class="btn btn-primary" onClick=${save}>Back to Outline</button>
                    <button class="btn btn-secondary" onClick=${() => rawMode.value = false}>Cancel</button>
                </div>
            </div>
            <textarea class="raw-editor"
                value=${rawContent.value}
                onInput=${e => rawContent.value = e.currentTarget.value}></textarea>
        </div>
    </div>`
}

export const optionsOpen = signal(false)

export function StatusToolbar() {
    const color = outline.isDirty ? 'var(--color-danger)' : 'var(--color-synced)'
    return html`
    <div class="status-toolbar">
        <div class="toolbar-actions">
            <button class="toolbar-btn" onClick=${() => {
            rawContent.value = outline.getVMD()
            rawMode.value = true
        }}>Raw</button>
            <button class="toolbar-btn" onClick=${() => optionsOpen.value = true}>Options</button>
        </div>
        <div class="toolbar-brand">
            <button class="toolbar-btn" onclick=${() => openModal('keyboard-shortcuts')}>?</button>
            <span class="sync-dot" style="background-color: ${color};" title="Sync: ${outline.isDirty.value ? 'unsynced' : 'synced'}"></span>
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
                        onInput=${e => { searchQuery.value = e.currentTarget.value; searchResultIndex.value = 0 }}
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
        ${item.parentId ? item.text.peek() : 'Home'}
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
        zoomDescEditing.value = true
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
                onKeyDown=${e => { if (e.key === 'Escape') { stopEditing(); e.preventDefault() } }}></textarea>`
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
    if (children.length === 0 && root.parentId) {
        function createFirstNode() {
            const n = outline.addChild(root.id, { text: '' })
            focusId.value = n.id
            focusType.value = 'text'
        }
        return html`<div class="outliner" key="${root.id}-root">
            <div class="empty-state" tabIndex="-1"
                onClick=${createFirstNode}
                onKeyDown=${e => { if (e.key === 'Enter') { createFirstNode(); e.preventDefault(); e.stopPropagation() } }}>
                Click here or press Enter to add a node
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
        currentSearchMatchId.value = id
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

document.onkeydown = keydown(focus)
document.body.focus()

const isDebug = new URLSearchParams(window.location.search).get('debug') === 'true'

export function DebugPanel() {
    if (!isDebug) return null
    return html`<div class="debug-panel">
        <div>focusPath: ${focusId.value || 'null'}</div>
        <div>zoomPath: ${outline.zoomId.value}</div>
        <div>historyLength: 0</div>
        <div>nodeCount: ${outline.nodeCount}</div>
    </div>`
}
