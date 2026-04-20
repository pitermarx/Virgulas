import outline from "./outline.js"
import { searchQuery, searchResultIndex, flatMatches, getFirstClosedParent, resetSearchNavigation } from './search.js'
import { log, store } from './utils.js';

export function handleSearchKeyDown(e, focus) {
    const results = searchQuery.value ? outline.search(searchQuery.value) : null
    const matches = results ? flatMatches(results) : []
    const idx = Math.min(searchResultIndex.value, Math.max(matches.length - 1, 0))

    function cycleNext(reverse) {
        if (matches.length === 0) return
        if (reverse) {
            searchResultIndex.value = (idx - 1 + matches.length) % matches.length
        } else {
            searchResultIndex.value = (idx + 1) % matches.length
        }
    }

    if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        cycleNext(e.shiftKey)
    } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        cycleNext(false)
    } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        cycleNext(true)
    } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (matches.length > 0 && matches[idx]) {
            const targetId = matches[idx]
            const zoomTarget = getFirstClosedParent(targetId)
            if (!zoomTarget) return
            zoomIn(zoomTarget, focus)
            focus.Id.value = targetId
            focus.Type.value = 'text'
        }
    }
}

export function zoomIn(id, focus) {
    const prevFocusId = focus.Id.value
    outline.zoomIn(id)
    window.location.hash = id
    const focusTarget = prevFocusId || id
    const first = outline.get(focusTarget)?.peek()?.children?.[0]
    if (first) {
        focus.Id.value = first
        focus.Type.value = 'text'
    }
}

export function zoomOut(focus) {
    const zoomId = outline.zoomId.value
    outline.zoomOut()

    const zoomedOutNode = outline.get(outline.zoomId.value).peek()
    if (zoomedOutNode && zoomedOutNode.parentId) {
        window.location.hash = zoomedOutNode.id
    } else {
        window.location.hash = ''
    }
    // focus the zoomed out node
    focus.Id.value = zoomId
    focus.Type.value = 'text'
}

function confirmDeleteNodeWithChildren(id) {
    const nodeToDelete = outline.get(id)
    if (!nodeToDelete || nodeToDelete.children.peek().length === 0) {
        return true
    }

    if (typeof confirm !== 'function') {
        return true
    }

    return confirm('Delete this node and all its children?')
}

function handleKeyDownOnFocusedNode(k, focus) {
    switch (k) {
        case 'Shift+Enter':
            focus.Type.value = focus.Type.value === 'text' ? 'description' : 'text'
            return true
        case 'Shift+ArrowDown':
            if (focus.Type.value === 'text') {
                const selIds = focus.SelectedIds.value
                if (selIds.length === 0) {
                    // Start selection from focused node
                    const nextId = outline.nextSibling(focus.Id.value)
                    if (nextId) {
                        focus.SelectedIds.value = [focus.Id.value, nextId]
                        focus.Id.value = nextId
                    }
                } else {
                    // Extend existing selection
                    const lastId = selIds[selIds.length - 1]
                    const nextId = outline.nextSibling(lastId)
                    if (nextId) {
                        focus.SelectedIds.value = [...selIds, nextId]
                        focus.Id.value = nextId
                    }
                }
                return true
            }
            break
        case 'Shift+ArrowUp':
            if (focus.Type.value === 'text') {
                const selIds = focus.SelectedIds.value
                if (selIds.length === 0) {
                    const prevId = outline.prevSibling(focus.Id.value)
                    if (prevId) {
                        focus.SelectedIds.value = [prevId, focus.Id.value]
                        focus.Id.value = prevId
                    }
                } else {
                    const firstId = selIds[0]
                    const prevId = outline.prevSibling(firstId)
                    if (prevId) {
                        focus.SelectedIds.value = [prevId, ...selIds]
                        focus.Id.value = prevId
                    }
                }
                return true
            }
            break
        case 'Delete':
            if (focus.SelectedIds?.value?.length > 0) {
                const ids = [...focus.SelectedIds.value]
                focus.SelectedIds.value = []
                focus.Id.value = null
                focus.Type.value = null
                for (const id of ids) {
                    outline.deleteNode(id)
                }
                return true
            }
            break
        case 'Enter':
            if (focus.Type.value === 'text') {
                const focusedNode = outline.get(focus.Id.value)
                let n
                // If the focused node has children and is expanded, add a new child.
                if (focusedNode.children.value.length > 0 && focusedNode.open.value) {
                    n = outline.addChild(focus.Id.value, { text: '' }, false)
                }
                // Otherwise, add a sibling node
                else {
                    n = outline.addChild(focusedNode.parentId, { text: '' }, focus.Id.value)
                }
                focus.Id.value = n.id
                return true
            }
            break;
        case 'Escape':
            if (focus.SelectedIds && focus.SelectedIds.value.length > 0) {
                focus.SelectedIds.value = []
            }
            focus.Id.value = null
            focus.Type.value = null
            document.body.focus()
            return true
        case 'Ctrl+ ':
            if (focus.SelectedIds?.value?.length > 0) {
                const ids = focus.SelectedIds.value
                const allCollapsed = ids.every(id => {
                    const node = outline.get(id)
                    return !node || node.children.peek().length === 0 || !node.open.peek()
                })
                const newOpen = allCollapsed
                for (const id of ids) {
                    const node = outline.get(id)
                    if (node && node.children.peek().length > 0) {
                        outline.update(id, { open: newOpen })
                    }
                }
                return true
            }
            const nodeToOpenToggle = outline.get(focus.Id.value)
            if (nodeToOpenToggle.children.value.length > 0) {
                outline.update(focus.Id.value, { open: !nodeToOpenToggle.open.value })
            }
            return true
        case 'ArrowDown':
            if (focus.Type.value === 'text') {
                focus.Id.value = outline.next(focus.Id.value)
                return true
            }
            break;
        case 'ArrowUp':
            if (focus.Type.value === 'text') {
                focus.Id.value = outline.prev(focus.Id.value)
                return true
            }
            break;
        case 'Backspace':
            if (focus.Type.value === 'text') {
                if (outline.get(focus.Id.value).text.value === '') {
                    const idToDelete = focus.Id.value
                    if (!confirmDeleteNodeWithChildren(idToDelete)) {
                        return true
                    }
                    focus.Id.value = outline.prev(focus.Id.value)
                    outline.deleteNode(idToDelete)
                    return true
                }
                // Non-empty text: let the browser handle normal character deletion
                break
            }
            if (focus.Type.value === 'description' && outline.get(focus.Id.value).description.value === '') {
                focus.Type.value = 'text'
                return true
            }
            break;
        case 'Ctrl+Backspace':
            if (focus.Type.value === 'text') {
                const idToDelete = focus.Id.value
                if (!confirmDeleteNodeWithChildren(idToDelete)) {
                    return true
                }
                focus.Id.value = outline.prev(idToDelete)
                outline.deleteNode(idToDelete)
                return true
            }
            if (focus.Type.value === 'description' && outline.get(focus.Id.value).description.value === '') {
                focus.Type.value = 'text'
                return true
            }
            break;
        case 'Tab':
            if (focus.Type.value === 'text') {
                if (focus.SelectedIds?.value?.length > 0) {
                    const ids = [...focus.SelectedIds.value]
                    for (const id of ids) {
                        outline.indent(id)
                    }
                    return true
                }
                outline.indent(focus.Id.value)
                return true
            }
            break;
        case 'Shift+Tab':
            if (focus.Type.value === 'text') {
                if (focus.SelectedIds?.value?.length > 0) {
                    const ids = [...focus.SelectedIds.value]
                    for (const id of ids) {
                        outline.outdent(id)
                    }
                    return true
                }
                outline.outdent(focus.Id.value)
                return true
            }
            break;
        case 'Alt+ArrowDown':
            if (focus.SelectedIds?.value?.length > 0) {
                const ids = [...focus.SelectedIds.value]
                for (let i = ids.length - 1; i >= 0; i--) {
                    outline.moveDown(ids[i])
                }
                return true
            }
            outline.moveDown(focus.Id.value)
            return true
        case 'Alt+ArrowUp':
            if (focus.SelectedIds?.value?.length > 0) {
                const ids = [...focus.SelectedIds.value]
                for (const id of ids) {
                    outline.moveUp(id)
                }
                return true
            }
            outline.moveUp(focus.Id.value)
            return true
        case 'Alt+ArrowLeft':
            zoomOut(focus)
            return true
        case 'Alt+ArrowRight':
            zoomIn(focus.Id.value, focus)
            return true
        case 'Ctrl+c':
            navigator.clipboard.writeText(outline.getVMD(focus.Id.value))
            return true
    }
}

function handleKeyDown(e, focus) {

    const k =
        e.ctrlKey && e.altKey ? `Ctrl+Alt+${e.key}` :
            e.shiftKey ? `Shift+${e.key}` :
                e.ctrlKey ? `Ctrl+${e.key}` :
                    e.altKey ? `Alt+${e.key}` :
                        e.key

    log('Key pressed:', k, 'Focused node:', focus.Id.value, 'Focus type:', focus.Type.value)

    switch (k) {
        case 'Ctrl+Alt+t':
            // Toggle theme. html data-theme[dark|light]
            const userPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            const defaultTheme = userPrefersDark ? 'dark' : 'light'
            const currentTheme = document.documentElement.getAttribute('data-theme') || defaultTheme
            const newTheme = currentTheme === 'light' ? 'dark' : 'light'
            document.documentElement.setAttribute('data-theme', newTheme)
            store.theme.set(newTheme)
            return true
        case 'Ctrl+Alt+w':
            // Toggle wide mode. norma = .main-content max-width: 800px, wide = max-width: none
            const mainContent = document.querySelector('.main-content')
            if (mainContent) {
                mainContent.style.maxWidth = mainContent.style.maxWidth === 'none' ? '800px' : 'none'
            }
            return true
    }

    if (focus.Id.value) {
        return handleKeyDownOnFocusedNode(k, focus)
    }

    switch (k) {
        // on down arrow, focus first child of document
        // on up arrow, focus last child of document
        case 'ArrowDown':
            const first = outline.getRoot().peek().children[0]
            focus.Id.value = first
            focus.Type.value = 'text'
            return true
        case 'ArrowUp':
            function findLastDescendant(node) {
                const p = node.peek()
                if (!node.open) return node.id
                if (p.children.length === 0) return node.id
                return findLastDescendant(outline.get(p.children[p.children.length - 1]))
            }
            const last = findLastDescendant(outline.getRoot())
            focus.Id.value = last
            focus.Type.value = 'text'
            return true
        case 'Enter':
            focus.Id.value = outline.addChild().id
            focus.Type.value = 'text'
            return true
        case 'Escape':
            toggleSearchMode(focus)
            return true
        case 'Alt+ArrowLeft':
            zoomOut(focus)
            return true
    }
}

export function keydown(focus) {
    return function keydownHandler(e) {
        if (handleKeyDown(e, focus)) {
            e.preventDefault()
            e.stopPropagation()
        }
    }
}

let prevFocusType = {}
export function toggleSearchMode(focus) {
    if (focus.Type.value === 'search') {
        focus.Type.value = prevFocusType
        resetSearchNavigation()
    }
    else {
        prevFocusType = focus.Type.value
        focus.Type.value = 'search'
        resetSearchNavigation()
    }
}
