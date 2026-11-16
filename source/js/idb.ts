// A tiny IndexedDB key-value store.
//
// Two device-local features need one: the File System Access handle cache
// (`fileHandles.ts`) and the biometric passphrase seal (`biometrics.ts`). Both
// used to carry their own open/get/put/delete quartet; this is the single
// implementation, and it keeps the open connection promise so repeated saves
// do not reopen the database.

interface IdbHandle {
    get<T>(key: string): Promise<T | null>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
}

const opened = new Map<string, Promise<IDBDatabase>>()

function open(dbName: string, storeName: string): Promise<IDBDatabase> {
    const cacheKey = `${dbName}/${storeName}`
    let promise = opened.get(cacheKey)
    if (!promise) {
        promise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbName, 1)
            request.onupgradeneeded = () => {
                const names = request.result.objectStoreNames
                if (!names || !names.contains(storeName)) {
                    request.result.createObjectStore(storeName)
                }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        // A failed open must not poison every later call.
        promise.catch(() => opened.delete(cacheKey))
        opened.set(cacheKey, promise)
    }
    return promise
}

/** A key-value handle over one object store. Fails with the IndexedDB error. */
export function idbStore(dbName: string, storeName: string): IdbHandle {
    return {
        async get<T>(key: string): Promise<T | null> {
            const db = await open(dbName, storeName)
            return new Promise<T | null>((resolve, reject) => {
                const tx = db.transaction(storeName, 'readonly')
                const request = tx.objectStore(storeName).get(key)
                request.onsuccess = () => resolve((request.result as T) ?? null)
                request.onerror = () => reject(request.error)
            })
        },

        async put(key: string, value: unknown): Promise<void> {
            const db = await open(dbName, storeName)
            return new Promise<void>((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite')
                tx.objectStore(storeName).put(value, key)
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error)
            })
        },

        async delete(key: string): Promise<void> {
            const db = await open(dbName, storeName)
            return new Promise<void>((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite')
                tx.objectStore(storeName).delete(key)
                tx.oncomplete = () => resolve()
                tx.onerror = () => reject(tx.error)
            })
        }
    }
}

/** Forget the cached connections (a test that swaps IndexedDB). */
export function resetIdbConnections() {
    opened.clear()
}
