// The outliner surface: the node tree, its description/text editors, search
// results and the global keyboard/hash entry points.
//
// Focus and selection live in `js/focus.ts`; the toolbar and task panel are their
// own files.

import { html } from 'htm/preact'
import { effect } from '@preact/signals'
import outline from '../js/outline.js'
import { renderInlineMarkdown } from '../js/markdown.js'
import { isMobile } from '../js/utils.js'
import { keydown, zoomIn, enterSearchMode, suppressUnhandledBackspace } from '../js/shortcuts.js'
import { searchQuery, searchResults, currentSearchMatchId, getFirstClosedParent, resetSearchNavigation } from '../js/search.js'
import { focus, focusId, focusType, selectedIds, requestNodeFocus, scheduleBlurClear, focusElement, focusMe } from '../js/focus.js'
import { pendingConflicts } from '../js/syncEngine.js'

function openSearchWithQuery(query: string) {
    const nextQuery = String(query || '').trim()
    if (!nextQuery) return
    enterSearchMode(focus)
    searchQuery.value = nextQuery
    resetSearchNavigation()
}

// Focus and selection styling move through this effect, not the render:
// NodeBody does not subscribe to focusId/selectedIds, so moving the focus no
// longer re-renders every visible node body. The render still peeks the
// current focus state, so a body re-rendered for its own reasons (children,
// task state) writes the same classes the effect maintains.
effect(() => {
    const focused = focusId.value
    const selected = selectedIds.value
    for (const el of document.querySelectorAll('.node-focused')) el.classList.remove('node-focused')
    for (const el of document.querySelectorAll('.node-selected')) el.classList.remove('node-selected')
    const focusedEl = focused ? document.querySelector(`[data-node-id="${CSS.escape(focused)}"]`) : null
    if (focusedEl) focusedEl.classList.add('node-focused')
    for (const id of selected) {
        const el = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
        if (el) el.classList.add('node-selected')
    }
})

export function handleInteractiveMarkdownClick(e: any) {
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

const fadedText = "color: var(--color-text-muted);"


const hasClosedChildrenBullet = html`<circle cx="25" cy="25" r="10" fill="none" stroke="currentColor" stroke-width="5"/>`
const NormalBullet = html`<circle cx="25" cy="25" r="10" fill="currentColor"/>`
const hasOpenChildrenBullet = html`<g><circle cx="25" cy="25" r="10" fill="currentColor"/><circle cx="25" cy="25" r="18" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.35"/></g>`



const SWIPE_MIN_DISTANCE_PX = 56
const SWIPE_AXIS_RATIO = 1.35

function firstTouch(list: any) {
    if (!list || list.length === 0) return null
    return list[0]
}

function isSwipeGesture(deltaX: number, deltaY: number) {
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)
    return absX >= SWIPE_MIN_DISTANCE_PX && absX > absY * SWIPE_AXIS_RATIO
}

function isSwipeBlockedTarget(target: any) {
    if (!(target instanceof Element)) return false
    return !!target.closest('input, textarea, a, button, .bullet, .collapse-toggle')
}

function NodeDesc({ node }: any) {
    // Read only the signals this component uses. `node.value` subscribes to all
    // of them, so a text edit would re-render every visible descendant.
    const id = node.id
    const description = node.description.value
    const focusDesc = (e: any) => {
        if (handleInteractiveMarkdownClick(e)) return
        requestNodeFocus(id, 'description')
        e.stopPropagation()
    }

    if (focusId.value === id && focusType.value === 'description') {
        function onBlur() {
            scheduleBlurClear(id, 'description')
        }
        function autosizeAndFocus(el: any) {
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
                onpaste=${(e: any) => {
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
                onInput=${(e: any) => {
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
        <div class="node-desc-md markdown-body" style=${style} dangerouslySetInnerHTML=${{ __html: style ? text : renderInlineMarkdown(text) }}></div></div>`
}

function NodeText({ node }: any) {
    // Only text/done: `node.value` would subscribe to every field and make a
    // sibling's edit re-render this node (and, through Node, its subtree).
    const id = node.id
    const text = node.text.value
    const done = node.done.value
    if (focusId.value === id && focusType.value === 'text') {
        const rawPrefix = done === true ? '[x] ' : done === false ? '[ ] ' : ''
        function onBlur() {
            scheduleBlurClear(id, 'text')
        }
        function onInput(e: any) {
            outline.updateTextRaw(id, e.target.value)
        }
        return html`<input
            ...${focusMe} type="text" onpaste=${(e: any) => {
                const text = e.clipboardData.getData('text/plain')
                const lines = text.split(/\r?\n/).filter((l: string) => l.trim())
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
            class="node-text-input" placeholder="Type here..." value=${rawPrefix + text}
            onBlur=${onBlur} onInput=${onInput} />`
    }

    return html`<div
        class="node-text-md"
        style=${text ? '' : fadedText}
        dangerouslySetInnerHTML=${{ __html: text ? renderInlineMarkdown(text, { decorateMeta: done !== null }) : '&nbsp;' }}
        onClick=${(e: any) => {
            if (e.target === e.currentTarget) {
                requestNodeFocus(id, 'text')
                e.stopPropagation()
                e.preventDefault()
            }
        }}></div>`
}

function NodeBody({ node }: any) {
    // Structure and task state only; text and description belong to NodeText
    // and NodeDesc, so editing them must not re-render the body. Focus and
    // selection are peeked, not subscribed: their styling moves through the
    // module effect above, so an arrow key costs two class toggles instead
    // of a re-render of every visible node.
    const id = node.id
    const children = node.children.value
    const open = node.open.value
    const done = node.done.value
    const hasChildren = children.length > 0
    const isFocused = focusId.peek() === id
    const isSelected = selectedIds.peek().includes(id)
    const isTask = done !== null
    const isDone = done === true
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

    function focusTextIfOnlyClickedThisElement(e: any) {
        if (handleInteractiveMarkdownClick(e)) return
        if (e.target.closest('.bullet, .collapse-toggle, .task-checkbox')) return
        selectedIds.value = []
        requestNodeFocus(id, 'text')
        e.stopPropagation()
    }

    function handleTouchStart(e: any) {
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

    function handleTouchMove(e: any) {
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

    function handleTouchEnd(e: any) {
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
    <div class=${'node-content' + (isFocused ? ' node-focused' : '') + (isSelected ? ' node-selected' : '') + (isTask ? ' node-task' : '') + (isDone ? ' node-done' : '')} data-node-id=${id}
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
        ${isTask && html`<button class=${'task-checkbox' + (isDone ? ' task-checkbox--done' : '')} onClick=${(e: any) => { e.stopPropagation(); outline.checkboxToggleDone(id) }} aria-label=${isDone ? 'Mark undone' : 'Mark done'} aria-pressed=${isDone}>
            <svg viewBox="0 0 16 16" width="16" height="16">
                ${isDone
                ? html`<rect x="1" y="1" width="14" height="14" rx="3" fill="var(--color-accent-primary)"/><path d="M4 8l2.5 2.5L12 5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
                : html`<rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="var(--color-text-faint)" stroke-width="1.5"/>`
            }
            </svg>
        </button>`}

    <div class="node-body">
        <${NodeText} node=${node} />
        <${NodeDesc} node=${node} />
    </div>
    ${hasChildren && html`<span class="collapse-toggle" onClick=${() => outline.toggleOpen(id)}>${open ? '▼' : '▶'}</span>`}
    </div>
    `
}

function Node({ node, indent = 0 }: any) {
    // Structure only. Reading `node.value` here subscribed the parent to every
    // field, so typing in one node re-created its whole visible subtree.
    const id = node.id
    const children = node.children.value
    const open = node.open.value
    const fontSize = indent === 0 ? `var(--text-size-root)` : `var(--text-size-level-${Math.min(indent, 2)})`;

    function toggleOpenIfOnlyClickedThisElement(e: any) {
        if (e.target === e.currentTarget) {
            outline.toggleOpen(id)
        }
    }
    return html`
    <div key=${id} class="node" style="font-size: ${fontSize};">
        <${NodeBody} node=${node} />
        ${open && children.length ? html`
        <div class="children" onClick=${toggleOpenIfOnlyClickedThisElement}>
            ${children.map(outline.get).filter((c: any) => c).map((child: any) => html`<${Node} node=${child} indent=${indent + 1} />`)}
        </div>` : ''}
    </div>
    `
}

// ── Tasks Panel ───────────────────────────────────────────────────────────────

export function Outline() {
    const root = outline.get(outline.zoomId.value) // subscribe to changes on root node and zoomed node
    if (focusType.value === 'search' && searchQuery.value) {
        const results = searchResults.value.tree
        return html`<div class="outliner search-results" key="search-results">
            ${(results?.children ?? []).map(result => html`<${SearchNode} node=${result} />`)}
        </div>`
    }

    if (!root) return null

    const children = root.children.value.map(outline.get).filter((c): c is NonNullable<ReturnType<typeof outline.get>> => !!c)
    if (children.length === 0) {
        function createFirstNode() {
            const n = outline.addChild(root!.id, { text: '' })
            focusId.value = n!.id
            focusType.value = 'text'
        }
        return html`<div class="outliner" key="${root.id}-root">
            <div class="empty-state" tabIndex="-1"
                onClick=${createFirstNode}
                onKeyDown=${(e: any) => { if (e.key === 'Enter') { createFirstNode(); e.preventDefault(); e.stopPropagation() } }}>
                Press Enter to start writing…
            </div>
        </div>`
    }

    return html`
    <div class="outliner" key="${root.id}-root">
        ${children.map(node => html`<${Node} node=${node} />`)}
    </div>`
}

function SearchNode({ node, indent = 0 }: any) {
    const { text, description, id, children, isMatch } = node
    const fontSize = indent === 0 ? `var(--text-size-root)` : `var(--text-size-level-${Math.min(indent, 2)})`;
    const isCurrent = currentSearchMatchId.value === id
    const style = isCurrent
        ? 'background-color: var(--color-search-current);'
        : isMatch ? 'background-color: var(--color-search-match);' : ''
    function clickResult(e: any) {
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
            ${children.map((child: any) => html`<${SearchNode} node=${child} indent=${indent + 1} />`)}
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

// ux-01: the SPEC says the app cannot be used until every conflict is resolved.
// The conflict dialog is blocking, so the outline's global shortcuts must not
// act behind it (the dialog has its own handler for the keys it consumes).
const outlineKeydown = keydown(focus)
document.onkeydown = (event: KeyboardEvent) => {
    if (pendingConflicts.peek().length > 0) {
        // Blocking means the browser's defaults stay out too: WebKit turns an
        // unhandled Backspace into a history navigation, which would leave the
        // app while the user is still answering the conflict.
        suppressUnhandledBackspace(event)
        return
    }
    outlineKeydown(event)
}
