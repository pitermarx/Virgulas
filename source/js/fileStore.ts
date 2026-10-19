// File adapter (docs/storage-interface.md §5, rollout PR 2a).
// Plain-text .vmd bytes through the File System Access API. The handle is
// acquired by the orchestration (showSaveFilePicker / remembered handle);
// this store only reads and writes it. Plain VMD at rest — no crypto, no
// unlock lifecycle.

import { StoreError, type StringStore } from './storage.js'

/** File mode needs showSaveFilePicker, which Firefox and Safari do not ship. */
export function isFileStoreAvailable(apis: { showSaveFilePicker?: unknown } = globalThis as any): boolean {
    return typeof apis.showSaveFilePicker === 'function'
}

/** The file's modification stamp, or null when the platform exposes none. */
function stampOf(file: File): string | null {
    const stamp = (file as any).lastModified
    return typeof stamp === 'number' ? String(stamp) : null
}

export function fileStore(handle: FileSystemFileHandle): StringStore {
    async function currentFile(): Promise<File> {
        try {
            return await handle.getFile()
        } catch (error) {
            if ((error as DOMException)?.name === 'NotAllowedError') {
                throw new StoreError('unauthenticated', 'File access permission was revoked. Re-select the file.', error)
            }
            throw error
        }
    }

    return {
        async read() {
            const file = await currentFile()
            const text = await file.text()
            return text.length > 0 ? text : null
        },
        async write(text) {
            const writable = await handle.createWritable()
            await writable.write(text)
            await writable.close()
            return stampOf(await currentFile())
        },
        async clear() {
            const writable = await handle.createWritable()
            await writable.write('')
            await writable.close()
        },
        async exists() {
            try {
                const file = await currentFile()
                if (typeof (file as any).size === 'number') return (file as any).size > 0
                // No size metadata (test doubles) — fall back to reading.
                return (await file.text()).length > 0
            } catch {
                return false
            }
        },
        async head() {
            try {
                return stampOf(await currentFile())
            } catch {
                return null
            }
        },
        capabilities: {
            durable: 'always',
            encrypted: false,
            authenticated: false,
            changeDetection: true,
            available: isFileStoreAvailable()
        }
    }
}
