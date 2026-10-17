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
            return String((await currentFile()).lastModified)
        },
        async clear() {
            const writable = await handle.createWritable()
            await writable.write('')
            await writable.close()
        },
        async exists() {
            try {
                return (await currentFile()).size > 0
            } catch {
                return false
            }
        },
        async head() {
            try {
                return String((await currentFile()).lastModified)
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
