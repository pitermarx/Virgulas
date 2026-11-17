// Focus and selection state for the outliner surface, plus the small DOM
// helpers that keep focus transfer from fighting a re-render.
//
// It lives here so the node/toolbar components (and `shortcuts.ts`'s callers)
// read one owner instead of a UI module that also renders them. The rendered
// components stay in `ui.ts` until the component split moves them out.

import { signal } from '@preact/signals'

export const focusId = signal<string | null>(null)
export const focusType = signal<string | null>(null)
export const selectedIds = signal<string[]>([])

/** The shape `shortcuts.ts` receives as `EditorFocus`. */
export const focus = { Id: focusId, Type: focusType, SelectedIds: selectedIds }

const FOCUS_TRANSFER_WINDOW_MS = 450
const BLUR_SETTLE_MS = 75
let pendingFocusTransfer: { id: string; type: string | null; expiresAt: number } | null = null

export function getNodeIdFromElement(el: any) {
    return el?.closest?.('.node-content')?.getAttribute('data-node-id') || null
}

export function markFocusTransfer(id: string | null, type: string | null) {
    pendingFocusTransfer = {
        id: String(id),
        type,
        expiresAt: Date.now() + FOCUS_TRANSFER_WINDOW_MS
    }
}

export function requestNodeFocus(id: string | null, type: string | null) {
    markFocusTransfer(id, type)
    focusId.value = id
    focusType.value = type
}

export function hasActiveTransferForOtherNode(id: string | null) {
    if (!pendingFocusTransfer) return false
    if (Date.now() > pendingFocusTransfer.expiresAt) {
        pendingFocusTransfer = null
        return false
    }
    return pendingFocusTransfer.id !== String(id)
}

export function clearTransferForElement(el: any) {
    if (!pendingFocusTransfer) return
    const nodeId = getNodeIdFromElement(el)
    if (nodeId && nodeId === pendingFocusTransfer.id) {
        pendingFocusTransfer = null
    }
}

export function focusElement(el: any) {
    if (!el) return
    if (document.activeElement !== el) {
        try {
            el.focus({ preventScroll: true })
        } catch {
            el.focus()
        }
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    clearTransferForElement(el)
}

export function scheduleBlurClear(id: string | null, type: string | null) {
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

export const focusMe = { ref: focusElement }
