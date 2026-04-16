import outline from './outline.js'
import { zoomIn, zoomOut, keydown, toggleSearchMode } from './shortcuts.js'
import {
    assert,
    assertEqual,
    cloneSections,
    createAsyncSectionHarness
} from './testing.js'

export const shortcutsTotal = 25

let _cachedResult = null

function installBrowserStubs() {
    const isBrowser =
        typeof globalThis.window === 'object' &&
        typeof globalThis.document === 'object' &&
        typeof globalThis.document.querySelector === 'function' &&
        typeof globalThis.document.createElement === 'function'

    if (!isBrowser) {
        globalThis.window = {
            location: { hash: '', search: '' },
            matchMedia: () => ({ matches: false })
        }

        const attrs = {}
        const mainContent = { style: { maxWidth: '800px' } }
        const body = {
            focused: false,
            focus() {
                this.focused = true
            }
        }

        globalThis.document = {
            body,
            documentElement: {
                getAttribute(name) {
                    return attrs[name] || null
                },
                setAttribute(name, value) {
                    attrs[name] = value
                }
            },
            querySelector(selector) {
                if (selector === '.main-content') return mainContent
                return null
            }
        }
    } else {
        if (!window.matchMedia) {
            window.matchMedia = () => ({ matches: false })
        }

        if (!document.querySelector('.main-content')) {
            const el = document.createElement('div')
            el.className = 'main-content'
            el.style.maxWidth = '800px'
            document.body.appendChild(el)
        } else {
            document.querySelector('.main-content').style.maxWidth = '800px'
        }

        document.body.focused = false
        const nativeFocus = document.body.focus ? document.body.focus.bind(document.body) : null
        document.body.focus = function focusWithFlag() {
            this.focused = true
            if (nativeFocus) nativeFocus()
        }
    }

    const clipboard = {
        text: '',
        writeText(text) {
            this.text = text
            return Promise.resolve()
        }
    }

    if (!globalThis.navigator) {
        Object.defineProperty(globalThis, 'navigator', {
            value: {},
            configurable: true,
            writable: true
        })
    }

    try {
        Object.defineProperty(globalThis.navigator, 'clipboard', {
            value: clipboard,
            configurable: true,
            writable: true
        })
    } catch {
        if (globalThis.navigator.clipboard && typeof globalThis.navigator.clipboard.writeText === 'function') {
            const originalWriteText = globalThis.navigator.clipboard.writeText.bind(globalThis.navigator.clipboard)
            globalThis.navigator.clipboard.writeText = text => {
                clipboard.text = text
                try {
                    return originalWriteText(text)
                } catch {
                    return Promise.resolve()
                }
            }
            globalThis.navigator.__shortcutsClipboard = clipboard
        }
    }
}

function createFocus(id = null, type = null) {
    return {
        Id: { value: id },
        Type: { value: type }
    }
}

function createKeyEvent({ key, ctrlKey = false, altKey = false, shiftKey = false }) {
    return {
        key,
        ctrlKey,
        altKey,
        shiftKey,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
            this.defaultPrevented = true
        },
        stopPropagation() {
            this.propagationStopped = true
        }
    }
}

function hashId() {
    const raw = (window.location && window.location.hash) || ''
    return raw.startsWith('#') ? raw.slice(1) : raw
}

export async function runShortcutsTests(onProgress) {
    if (_cachedResult) {
        if (onProgress) onProgress(_cachedResult)
        return _cachedResult
    }

    const harness = createAsyncSectionHarness({
        onProgress,
        beforeEach: async () => {
            outline.reset()
            installBrowserStubs()
        }
    })
    const { section, test } = harness

    section('Search mode')

    await test('toggleSearchMode enters and exits search restoring previous type', async () => {
        const focus = createFocus('A', 'text')

        toggleSearchMode(focus)
        assertEqual(focus.Type.value, 'search', 'First toggle should enter search mode')

        toggleSearchMode(focus)
        assertEqual(focus.Type.value, 'text', 'Second toggle should restore previous mode')
    })

    section('Direct zoom helpers')

    await test('zoomIn updates zoom id, location hash, and focuses previous child', async () => {
        const a = outline.addChild('root', { id: 'A', text: 'A' })
        const b = outline.addChild('root', { id: 'B', text: 'B' })
        const a1 = outline.addChild('A', { id: 'A1', text: 'A1' })
        const focus = createFocus(a.id, 'text')

        zoomIn(b.id, focus)

        assertEqual(outline.zoomId.value, b.id, 'zoomIn should move zoom to selected id')
        assertEqual(hashId(), b.id, 'zoomIn should update location hash')
        assertEqual(focus.Id.value, a1.id, 'focus id should move to first child of previous focus')
        assertEqual(focus.Type.value, 'text', 'focus type should remain text after zoomIn')
    })

    await test('zoomOut updates zoom id, hash, and focused id', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        outline.zoomIn('A')
        outline.zoomIn('A1')
        const focus = createFocus('A1', 'text')

        zoomOut(focus)

        assertEqual(outline.zoomId.value, 'A', 'zoomOut should move zoom to parent')
        assertEqual(hashId(), 'A', 'zoomOut should update location hash to current zoom node')
        assertEqual(focus.Id.value, 'A1', 'focus id should be set to the node that was zoomed out from')
        assertEqual(focus.Type.value, 'text', 'focus type should be text after zoomOut')
    })

    section('Keyboard handler')

    await test('Ctrl+Alt+t toggles document theme and consumes event', async () => {
        const focus = createFocus(null, null)
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 't', ctrlKey: true, altKey: true })
        document.documentElement.setAttribute('data-theme', 'light')

        await handle(event)

        assertEqual(document.documentElement.getAttribute('data-theme'), 'dark', 'Theme should toggle to dark')
        assert(event.defaultPrevented, 'Handled shortcut should prevent default')
        assert(event.propagationStopped, 'Handled shortcut should stop propagation')
    })

    await test('Ctrl+Alt+w toggles wide mode and consumes event', async () => {
        const focus = createFocus(null, null)
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'w', ctrlKey: true, altKey: true })

        await handle(event)
        assertEqual(document.querySelector('.main-content').style.maxWidth, 'none', 'First toggle should enable wide mode')

        await handle(event)
        assertEqual(document.querySelector('.main-content').style.maxWidth, '800px', 'Second toggle should restore default width')
        assert(event.defaultPrevented, 'Handled shortcut should prevent default')
    })

    await test('Escape clears focused node and focuses body', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'Escape' })

        await handle(event)

        assertEqual(focus.Id.value, null, 'Escape should clear focused id')
        assertEqual(focus.Type.value, null, 'Escape should clear focused type')
        assert(document.body.focused, 'Escape should move focus to document body')
    })

    await test('Enter on focused text without children creates a sibling after the focused node', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: 'B' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'Enter' })

        await handle(event)

        const children = outline.get('root').children.peek()
        assertEqual(children.length, 3, 'A new child should be added at root level')
        assertEqual(children[0], 'A', 'Original first child should remain in place')
        assertEqual(children[2], 'B', 'Original next sibling should still be after inserted node')
        assert(children[1] === focus.Id.value, 'Focus should point to the newly inserted node')
    })

    await test('Enter on focused text with children creates first child', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'Enter' })

        await handle(event)

        const children = outline.get('A').children.peek()
        assertEqual(children.length, 2, 'A new child should be added under the focused node')
        assertEqual(children[1], 'A1', 'Existing child should be pushed to second position')
        assert(children[0] === focus.Id.value, 'Focus should point to the newly inserted first child')
    })

    await test('Alt+ArrowRight zooms in from focused node and consumes event', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'ArrowRight', altKey: true })

        await handle(event)

        assertEqual(outline.zoomId.value, 'A', 'Alt+ArrowRight should zoom into focused node')
        assertEqual(hashId(), 'A', 'Alt+ArrowRight should set hash to focused node id')
        assertEqual(focus.Id.value, 'A1', 'Alt+ArrowRight should move focus to first child of previous focus')
        assert(event.defaultPrevented, 'Handled shortcut should prevent default')
    })

    await test('Alt+ArrowLeft zooms out from current zoom and consumes event', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        outline.zoomIn('A')
        outline.zoomIn('A1')
        const focus = createFocus('A1', 'text')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'ArrowLeft', altKey: true })

        await handle(event)

        assertEqual(outline.zoomId.value, 'A', 'Alt+ArrowLeft should zoom out to parent node')
        assertEqual(hashId(), 'A', 'Alt+ArrowLeft should set hash to current zoom node')
        assertEqual(focus.Type.value, 'text', 'Alt+ArrowLeft should keep focus type as text')
        assert(event.defaultPrevented, 'Handled shortcut should prevent default')
    })

    await test('Shift+Enter toggles between text and description on focused node', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Enter', shiftKey: true }))
        assertEqual(focus.Type.value, 'description', 'Shift+Enter should switch text to description')

        await handle(createKeyEvent({ key: 'Enter', shiftKey: true }))
        assertEqual(focus.Type.value, 'text', 'Shift+Enter should switch description back to text')
    })

    await test('ArrowDown and ArrowUp move focus between siblings when focused on text', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: 'B' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'ArrowDown' }))
        assertEqual(focus.Id.value, 'B', 'ArrowDown should move focus to next node')

        await handle(createKeyEvent({ key: 'ArrowUp' }))
        assertEqual(focus.Id.value, 'A', 'ArrowUp should move focus to previous node')
    })

    await test('Ctrl+Space toggles node open state when focused node has children', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: ' ', ctrlKey: true }))
        assertEqual(outline.get('A').open.value, false, 'Ctrl+Space should close node')

        await handle(createKeyEvent({ key: ' ', ctrlKey: true }))
        assertEqual(outline.get('A').open.value, true, 'Ctrl+Space should reopen node')
    })

    await test('Backspace on empty focused text deletes node and focuses previous', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: '' })
        const focus = createFocus('B', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Backspace' }))

        const children = outline.get('root').children.peek()
        assertEqual(children.length, 1, 'Backspace should delete empty focused node')
        assertEqual(children[0], 'A', 'Remaining node should be previous sibling')
        assertEqual(focus.Id.value, 'A', 'Focus should move to previous sibling after delete')
    })

    await test('Backspace on empty description switches focus type back to text', async () => {
        outline.addChild('root', { id: 'A', text: 'A', description: '' })
        const focus = createFocus('A', 'description')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Backspace' }))
        assertEqual(focus.Type.value, 'text', 'Backspace in empty description should return to text mode')
    })

    await test('Ctrl+Backspace on non-empty focused text deletes node and focuses previous', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: 'B' })
        const focus = createFocus('B', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Backspace', ctrlKey: true }))

        const children = outline.get('root').children.peek()
        assertEqual(children.length, 1, 'Ctrl+Backspace should delete the node even with text')
        assertEqual(children[0], 'A', 'Remaining node should be previous sibling')
        assertEqual(focus.Id.value, 'A', 'Focus should move to previous sibling after delete')
    })

    await test('Ctrl+Backspace on empty focused text deletes node and focuses previous', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: '' })
        const focus = createFocus('B', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Backspace', ctrlKey: true }))

        const children = outline.get('root').children.peek()
        assertEqual(children.length, 1, 'Ctrl+Backspace should delete empty focused node')
        assertEqual(children[0], 'A', 'Remaining node should be previous sibling')
        assertEqual(focus.Id.value, 'A', 'Focus should move to previous sibling after delete')
    })

    await test('Enter on focused description does not create a new node', async () => {
        outline.addChild('root', { id: 'A', text: 'A', description: 'desc' })
        const focus = createFocus('A', 'description')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'Enter' })

        await handle(event)

        assertEqual(outline.get('root').children.peek().length, 1, 'Enter in description should not add siblings')
        assertEqual(focus.Id.value, 'A', 'Focus should stay on the same node')
        assertEqual(event.defaultPrevented, false, 'Unhandled Enter in description should not prevent default')
    })

    await test('Tab and Shift+Tab indent and outdent the focused node', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: 'B' })
        outline.addChild('root', { id: 'C', text: 'C' })
        const focus = createFocus('B', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Tab' }))
        assertEqual(outline.get('B').parentId, 'A', 'Tab should indent B under previous sibling A')

        await handle(createKeyEvent({ key: 'Tab', shiftKey: true }))
        assertEqual(outline.get('B').parentId, 'root', 'Shift+Tab should outdent B back to root')
    })

    await test('Alt+ArrowDown and Alt+ArrowUp move focused node among siblings', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: 'B' })
        outline.addChild('root', { id: 'C', text: 'C' })
        const focus = createFocus('B', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'ArrowDown', altKey: true }))
        assertEqual(outline.get('root').children.peek()[2], 'B', 'Alt+ArrowDown should move B below C')

        await handle(createKeyEvent({ key: 'ArrowUp', altKey: true }))
        assertEqual(outline.get('root').children.peek()[1], 'B', 'Alt+ArrowUp should move B back above C')
    })

    await test('Ctrl+c copies focused subtree VMD to clipboard', async () => {
        outline.addChild('root', { id: 'A', text: 'Alpha' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'c', ctrlKey: true }))

        const copied = (globalThis.navigator.clipboard && globalThis.navigator.clipboard.text) ||
            (globalThis.navigator.__shortcutsClipboard && globalThis.navigator.__shortcutsClipboard.text) || ''
        assert(copied.includes('Alpha'), 'Ctrl+c should copy focused node VMD text')
    })

    await test('ArrowDown with no focused node focuses first root child', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('root', { id: 'B', text: 'B' })
        const focus = createFocus(null, null)
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'ArrowDown' }))

        assertEqual(focus.Id.value, 'A', 'ArrowDown should focus the first root child when nothing is focused')
        assertEqual(focus.Type.value, 'text', 'ArrowDown should set focus type to text')
    })

    await test('ArrowUp with no focused node focuses last visible descendant', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        outline.addChild('root', { id: 'B', text: 'B' })
        const focus = createFocus(null, null)
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'ArrowUp' }))

        assertEqual(focus.Id.value, 'B', 'ArrowUp should focus the last visible descendant from root')
        assertEqual(focus.Type.value, 'text', 'ArrowUp should set focus type to text')
    })

    await test('Enter with no focused node creates a new root child', async () => {
        const focus = createFocus(null, null)
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Enter' }))

        assert(focus.Id.value, 'Enter should create and focus a new node when nothing is focused')
        assertEqual(focus.Type.value, 'text', 'Enter should set focus type to text')
        assert(outline.get('root').children.peek().includes(focus.Id.value), 'New node should be added at root level')
    })

    await test('Escape with no focused node toggles search mode', async () => {
        const focus = createFocus(null, null)
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'Escape' }))
        assertEqual(focus.Type.value, 'search', 'Escape with no focus should enter search mode')

        await handle(createKeyEvent({ key: 'Escape' }))
        assertEqual(focus.Type.value, null, 'Escape with no focus should toggle search mode off')
    })

    await test('Alt+ArrowLeft with no focused node zooms out one level', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        outline.addChild('A', { id: 'A1', text: 'A1' })
        outline.zoomIn('A')
        const focus = createFocus(null, null)
        const handle = keydown(focus)

        await handle(createKeyEvent({ key: 'ArrowLeft', altKey: true }))

        assertEqual(outline.zoomId.value, 'root', 'Alt+ArrowLeft with no focus should zoom out to root')
        assertEqual(focus.Id.value, 'A', 'Focus should be set to the node that was zoomed out from')
        assertEqual(focus.Type.value, 'text', 'Focus type should be text after zoom out')
    })

    await test('Unhandled key does not consume event', async () => {
        outline.addChild('root', { id: 'A', text: 'A' })
        const focus = createFocus('A', 'text')
        const handle = keydown(focus)
        const event = createKeyEvent({ key: 'z' })

        await handle(event)

        assertEqual(event.defaultPrevented, false, 'Unhandled keys should not prevent default')
        assertEqual(event.propagationStopped, false, 'Unhandled keys should not stop propagation')
    })

    _cachedResult = { sections: cloneSections(harness.sections), summary: harness.summary() }
    return _cachedResult
}