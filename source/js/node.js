import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import outline from "./outline.js"
import { log, isMobile } from './utils.js';
import { keydown, zoomIn, toggleSearchMode } from './shortcuts.js';

const searchQuery = signal('')

const focusId = signal(null)
const focusType = signal(null)
const focus = { Id: focusId, Type: focusType }
const focusMe = { ref: (el) => el && el.focus() }

const fadedText = "color: var(--color-text-muted);"

const hasClosedChildrenBullet = html`<circle cx="25" cy="25" r="10" fill="none" stroke="currentColor" stroke-width="5"/>`
const NormalBullet = html`<circle cx="25" cy="25" r="10" fill="currentColor"/>`

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
        lines[1] += '...'
    }

    let text = lines.slice(0, 2).join('\n')
    let style = ''
    if (!text && focusId.value === id) {
        text = 'Add description...'
        style = fadedText
    }

    return html`<div class="node-description" onClick=${focusDesc}>
        <div class="node-desc-md" style=${style}>${text}</div></div>`
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
        onClick=${e => {
            if (e.target === e.currentTarget) {
                focusId.value = id
                focusType.value = 'text'
                e.stopPropagation()
                e.preventDefault()
            }
        }}>${text || " "}</div>`
}

function NodeBody({ node }) {
    const { id, children, open } = node.value // subscribe to changes on node
    const hasChildren = children.length > 0
    const isFocused = focusId.value === id
    function focusTextIfOnlyClickedThisElement(e) {
        if (e.target === e.currentTarget) {
            focusId.value = id
            focusType.value = 'text'
            e.stopPropagation()
        }
    }
    return html`
    <div class="node-content ${isFocused ? 'node-focused' : ''}" data-node-id=${id} onClick=${focusTextIfOnlyClickedThisElement}>
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

export function StatusToolbar() {
    const color = outline.isDirty ? 'var(--color-danger)' : 'var(--color-synced)'
    return html`
    <div class="status-toolbar">
        <div class="toolbar-actions">
            <button class="toolbar-btn">Options</button>
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
        return html`<div class="main-toolbar">
            <${Breadcrumbs} />
            <div class="search-bar">
                <div class="search-bar-inner">
                    <input placeholder="Search..." ...${focusMe} class="search-input"
                        value=${searchQuery} onInput=${e => searchQuery.value = e.currentTarget.value} />
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

function Breadcrumbs() {
    const root = outline.get(outline.zoomId.value)
    if (!root || !root.parentId) return null
    const items = []
    let current = root
    while (current) {
        items.unshift(current)
        current = outline.get(current.parentId)
    }
    const text = root.description.value || '';
    return html`<div class="breadcrumbs">
        ${items.map((item, index) => html`<${BreadcrumbItem} item=${item} active=${index === items.length - 1} />`)}
    </div>
    <div class="zoom-description-area">
        <textarea
            class="zoom-desc-textarea"
            placeholder="Add a description..."
            rows=${text.split('\n').length || 1}
            value=${root.description}
            onInput=${e => outline.update(root.id, { description: e.currentTarget.value })}></textarea>
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

    return html`
    <div class="outliner" key="${root.id}-root">
        ${root.children.value.map(outline.get).filter(c => c).map(node => html`<${Node} node=${node} />`)}
    </div>`
}

function getFirstClosedParent(id) {
    const node = outline.get(id)
    if (!node || !node.open.value || !node.parentId) return node.id
    return getFirstClosedParent(node.parentId)
}

function SearchNode({ node, indent = 0 }) {
    const { text, description, id, children, isMatch } = node
    const fontSize = indent === 0 ? `var(--text-size-root)` : `var(--text-size-level-${Math.min(indent, 2)})`;
    const style = isMatch ? 'background-color: var(--color-search-match);' : ''
    function clickResult(e) {
        zoomIn(getFirstClosedParent(id), focus)
        searchQuery.value = ''
        focusId.value = id
        focusType.value = 'text'
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
