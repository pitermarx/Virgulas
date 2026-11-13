// a11y-02: one focus contract for every dialog.
//
// A dialog must move focus inside when it opens, keep Tab inside while it is
// modal, and hand focus back to whatever opened it when it closes. The sync
// conflict dialog is blocking: it takes focus but Escape must not close it.
//
// The app renders with signals and Preact components without hooks, so the
// binding follows the same pattern: one `effect` per dialog watches its open
// signal, and the focus work happens after the DOM for that state exists.

import { effect, type Signal } from '@preact/signals';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(',')

/** The focusable controls inside a dialog, in tab order, skipping hidden ones. */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(element => !element.hasAttribute('inert') && element.getClientRects().length > 0)
}

export interface DialogFocusOptions {
    /** Called for Escape. Omit it on a blocking dialog: Escape must do nothing. */
    onEscape?: () => void
    /** Keep Tab inside the dialog (default true). */
    trap?: boolean
    /** The control to focus first; defaults to the first focusable one. */
    initial?: (dialog: HTMLElement) => HTMLElement | null
}

/**
 * Moves focus into `dialog`, keeps Tab inside it and restores focus to the
 * opener. Returns the cleanup to run when the dialog closes.
 */
export function openDialogFocus(dialog: HTMLElement, options: DialogFocusOptions = {}): () => void {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const trap = options.trap !== false

    const initial = options.initial?.(dialog) ?? focusablesIn(dialog)[0] ?? null
    if (initial) {
        initial.focus()
    } else {
        dialog.tabIndex = -1
        dialog.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            if (!options.onEscape) return
            event.preventDefault()
            event.stopPropagation()
            options.onEscape()
            return
        }
        if (event.key !== 'Tab' || !trap) return

        const items = focusablesIn(dialog)
        if (items.length === 0) {
            event.preventDefault()
            return
        }
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
            event.preventDefault()
            last.focus()
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
            event.preventDefault()
            first.focus()
        }
    }

    dialog.addEventListener('keydown', onKeyDown)
    return () => {
        dialog.removeEventListener('keydown', onKeyDown)
        if (opener && document.contains(opener)) opener.focus()
    }
}

/**
 * Binds the focus contract to a dialog that is rendered while `open` is true.
 * `labelId` names the dialog's `aria-labelledby`, which is how it is found once
 * it has rendered.
 */
export function bindDialogFocus(
    open: Signal<boolean>,
    options: DialogFocusOptions & { labelId: string }
): void {
    let release: (() => void) | null = null

    effect(() => {
        const isOpen = open.value
        if (isOpen) {
            if (release) return
            // The dialog renders after this effect runs; wait for that frame.
            requestAnimationFrame(() => {
                if (!open.value || release) return
                const dialog = document.querySelector<HTMLElement>(`[aria-labelledby="${options.labelId}"]`)
                if (!dialog) return
                release = openDialogFocus(dialog, options)
            })
        } else if (release) {
            release()
            release = null
        }
    })
}
