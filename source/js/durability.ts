// Local-storage durability: whether the browser promises to keep the
// encrypted document, and the dismissible "best-effort" reminder.
//
// Safari tabs report best-effort even when `navigator.storage.persisted()`
// resolves true, so the browser check is part of the answer, not a hint.
// Self-contained: persistence and the Options modal read the signals; nothing
// here knows about the document or the stores.

import { signal } from '@preact/signals'
import { isStoragePersistent, requestPersistentStorage, store } from './utils.js'

export const localStorageDurability = signal<'persistent' | 'best-effort'>('best-effort')
export const localStoragePersistenceNotice = signal(false)

let persistenceRequest: Promise<boolean> | null = null

function isAppleBrowserTab() {
    if (typeof navigator === 'undefined') return false
    const nav = navigator as Navigator & { standalone?: boolean }
    const standalone = nav.standalone === true
        || (typeof window !== 'undefined' && !!window.matchMedia?.('(display-mode: standalone)').matches)
    return navigator.vendor === 'Apple Computer, Inc.' && !standalone
}

function updateLocalStorageDurability(persistent: boolean, showNotice: boolean) {
    const isPersistent = persistent && !isAppleBrowserTab()
    localStorageDurability.value = isPersistent ? 'persistent' : 'best-effort'
    if (showNotice && !isPersistent && store.storageNoticeDismissed.get() !== '1') {
        localStoragePersistenceNotice.value = true
    }
}

export async function refreshLocalStorageDurability(showNotice: boolean) {
    updateLocalStorageDurability(await isStoragePersistent(), showNotice)
}

/** Ask the browser once per session; later calls reuse the same promise. */
export function requestLocalStorageDurability(): Promise<boolean> {
    if (!persistenceRequest) {
        persistenceRequest = requestPersistentStorage().then(persistent => {
            updateLocalStorageDurability(persistent, true)
            return persistent
        })
    }
    return persistenceRequest
}

export function dismissLocalStoragePersistenceNotice() {
    localStoragePersistenceNotice.value = false
    store.storageNoticeDismissed.set('1')
}
