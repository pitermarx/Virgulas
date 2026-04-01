import outline from "./outline.js"
import { log } from './utils.js';

export function zoomIn(id, focus) {
    const prevFocus = focus.Id.value
    outline.zoomIn(id)
    window.location.hash = id
    if (prevFocus) {
        const first = outline.get(prevFocus).peek().children[0]
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
    }
    // focus the zoomed out node
    focus.Id.value = zoomId
    focus.Type.value = 'text'
}

async function handleKeyDownOnFocusedNode(k, focus) {
    switch (k) {
        case 'Shift+Enter':
            focus.Type.value = focus.Type.value === 'text' ? 'description' : 'text'
            return true
        case 'Enter':
            if (focus.Type.value === 'text') {
                const parentId = outline.get(focus.Id.value).parentId
                const n = outline.addChild(parentId, { text: '' }, focus.Id.value)
                focus.Id.value = n.id
                return true
            }
            break;
        case 'Escape':
            focus.Id.value = null
            focus.Type.value = null
            document.body.focus()
            return true
        case 'Ctrl+ ':
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
        case 'Ctrl+Backspace':
            if (focus.Type.value === 'text' && outline.get(focus.Id.value).text.value === '') {
                const idToDelete = focus.Id.value
                focus.Id.value = outline.prev(focus.Id.value)
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
                outline.indent(focus.Id.value)
                return true
            }
            break;
        case 'Shift+Tab':
            if (focus.Type.value === 'text') {
                outline.outdent(focus.Id.value)
                return true
            }
            break;
        case 'Alt+ArrowDown':
            outline.moveDown(focus.Id.value)
            return true
        case 'Alt+ArrowUp':
            outline.moveUp(focus.Id.value)
            return true
        case 'Alt+ArrowLeft':
            zoomOut()
            return true
        case 'Alt+ArrowRight':
            zoomIn(focus.Id.value)
            return true
        case 'Ctrl+c':
            navigator.clipboard.writeText(outline.getVMD(focus.Id.value))
            return true
    }
}

async function handleKeyDow(e, focus) {

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
        return await handleKeyDownOnFocusedNode(k, focus)
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
            zoomOut()
            return true
    }
}

export function keydown(focus) {
    return async function keydownHandler(e) {
        if (await handleKeyDow(e, focus)) {
            e.preventDefault()
            e.stopPropagation()
        }
    }
}

let prevFocusType = {}
export function toggleSearchMode(focus) {
    if (focus.Type.value === 'search') {
        focus.Type.value = prevFocusType
    }
    else {
        prevFocusType = focus.Type.value
        focus.Type.value = 'search'
    }
}
