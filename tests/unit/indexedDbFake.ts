// A minimal in-memory IndexedDB for unit tests (happy-dom does not provide one).
//
// Shared by the suites that exercise `idb.ts` directly and by `biometrics.ts`,
// which seals a passphrase in the same kind of store. `installFakeIndexedDB()`
// replaces the global and drops the cached connections, so each call starts from
// a clean database.

import { resetIdbConnections } from '../../source/js/idb.js'

class FakeRequest<T> {
    onsuccess: (() => void) | null = null
    onerror: (() => void) | null = null
    onupgradeneeded: (() => void) | null = null
    error: unknown = null
    constructor(public result: T) { }
}

class FakeObjectStore {
    data = new Map<string, unknown>()

    get(key: string) {
        const req = new FakeRequest<unknown>(this.data.get(key))
        queueMicrotask(() => req.onsuccess?.())
        return req
    }

    put(value: unknown, key: string) {
        this.data.set(key, value)
        return new FakeRequest<undefined>(undefined)
    }

    delete(key: string) {
        this.data.delete(key)
        return new FakeRequest<undefined>(undefined)
    }
}

class FakeTransaction {
    oncomplete: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(private db: FakeDB) {
        queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()))
    }

    objectStore(name: string) {
        return this.db.storeFor(name)
    }
}

class FakeDB {
    private stores = new Map<string, FakeObjectStore>()

    storeFor(name: string) {
        let store = this.stores.get(name)
        if (!store) {
            store = new FakeObjectStore()
            this.stores.set(name, store)
        }
        return store
    }

    createObjectStore(name: string) {
        return this.storeFor(name)
    }

    transaction(name: string, _mode: string) {
        this.storeFor(name)
        return new FakeTransaction(this)
    }
}

/** Replace `indexedDB` with a fresh in-memory implementation. */
export function installFakeIndexedDB() {
    resetIdbConnections()
    const databases = new Map<string, FakeDB>()
    ;(globalThis as any).indexedDB = {
        open(name: string) {
            let db = databases.get(name)
            if (!db) {
                db = new FakeDB()
                databases.set(name, db)
            }
            const req = new FakeRequest(db)
            queueMicrotask(() => {
                req.onupgradeneeded?.()
                req.onsuccess?.()
            })
            return req
        }
    }
}

/** Remove the fake, for the "browser has no IndexedDB" cases. */
export function uninstallFakeIndexedDB() {
    ;(globalThis as any).indexedDB = undefined
    resetIdbConnections()
}
