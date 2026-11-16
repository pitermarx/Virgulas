// The File System Access handle cache: remembers which `.vmd` file the user
// opened last, so a reload can reopen it without a picker.
//
// The handle itself is stored in IndexedDB (structured-cloneable); the document
// bytes are the file's job (`fileStore.ts`). File mode exists only in Chromium
// browsers, so every entry point checks `isSupported()`.

import { idbStore } from './idb.js'

const IDB_DB = 'virgulas-fs'
const IDB_STORE = 'handles'
const IDB_KEY = 'last-file'

const handles = idbStore(IDB_DB, IDB_STORE)

let current: FileSystemFileHandle | null = null

export const fileHandleStore = {
    isSupported: () => typeof window !== 'undefined' && !!window.showOpenFilePicker,

    /** Acquires a handle from the picker. Reading is the file store's job. */
    async open() {
        const [handle] = await window.showOpenFilePicker!({
            types: [{ description: 'Virgulas document', accept: { 'text/plain': ['.vmd'] } }]
        })
        current = handle
        await this.save(handle)
    },

    /** Reopens the remembered handle; false means "ask the user". */
    async tryReopen() {
        const handle = await handles.get<FileSystemFileHandle>(IDB_KEY).catch(() => null)
        if (!handle) return false
        try {
            const perm = await handle.queryPermission?.({ mode: 'readwrite' })
            if (perm === 'denied') return false
            if (perm !== 'granted') {
                const requested = await handle.requestPermission?.({ mode: 'readwrite' })
                if (requested !== 'granted') return false
            }
            // Probe readability: a deleted/inaccessible file falls back to the picker.
            await handle.getFile()
            current = handle
            return true
        } catch {
            return false
        }
    },

    async hasSavedHandle() {
        return !!(await handles.get(IDB_KEY).catch(() => null))
    },

    async pickNewFile() {
        current = null
        await this.open()
    },

    currentHandle: () => current,

    /** Remember a handle (also used after a test seeds one). */
    async save(handle: FileSystemFileHandle) {
        await handles.put(IDB_KEY, handle).catch(() => { /* a private window may refuse */ })
    },

    async clear() {
        current = null
        await handles.delete(IDB_KEY).catch(() => { /* already gone */ })
    }
}
