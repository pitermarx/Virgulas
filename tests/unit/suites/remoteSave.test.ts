import { describe, it, beforeEach, afterEach } from 'bun:test'
import {
    saveRemoteDocument,
    setRemoteSaveStore,
    getRemoteSaveStore,
    clearDeferredPush
} from '../../../source/js/remoteSave.js'
import outline from '../../../source/js/outline.js'
import {
    allowImmediateRemoteSync,
    noteLocalWriteActivity,
    setLastSyncedAt,
    setSyncHead,
    skipNextRemotePush,
    syncStatus
} from '../../../source/js/sync.js'
import { StoreError, type DocStore, type StoreCapabilities } from '../../../source/js/storage.js'
import type { OutlineDoc } from '../../../source/js/docCodec.js'
import { assertEqual } from '../testing.js'

const CAPABILITIES: StoreCapabilities = {
    durable: 'always',
    encrypted: true,
    authenticated: true,
    changeDetection: true,
    available: true
}

const DOC: OutlineDoc = {
    modelVersion: 'v1',
    dataVersion: 1,
    nodes: [{ id: 'root', text: '', children: ['a'] }, { id: 'a', text: 'Hello', parentId: 'root', children: [] }]
}

interface FakeStore {
    store: DocStore
    writes: OutlineDoc[]
}

/** A DocStore whose write can be scripted; head is always null (direct push). */
function fakeDocStore(write: (doc: OutlineDoc, attempt: number) => Promise<string | null>): FakeStore {
    const writes: OutlineDoc[] = []
    return {
        writes,
        store: {
            async read() { return null },
            async write(doc) {
                writes.push(doc)
                return write(doc, writes.length)
            },
            async clear() { },
            async exists() { return false },
            async head() { return null },
            async unlock() { },
            async lock() { },
            capabilities: CAPABILITIES
        }
    }
}

beforeEach(() => {
    allowImmediateRemoteSync()
    clearDeferredPush()
    setRemoteSaveStore(null)
    setSyncHead(null)
    setLastSyncedAt(0)
    skipNextRemotePush.value = false
    window.__retryBaseMs = 1
})

afterEach(() => {
    clearDeferredPush()
    setRemoteSaveStore(null)
    window.__retryBaseMs = undefined
    outline.dirtyDebounceTimeout = 800
    syncStatus.value = 'synced'
    skipNextRemotePush.value = false
})

describe('remoteSave store injection', () => {

    it('setRemoteSaveStore exposes the composed store and null tears it down', () => {
        const { store } = fakeDocStore(async () => null)
        setRemoteSaveStore(store)
        assertEqual(getRemoteSaveStore(), store, 'the save handle is the injected store')
        setRemoteSaveStore(null)
        assertEqual(getRemoteSaveStore(), null, 'teardown clears the handle')
    })

    it('saveRemoteDocument without a store is a no-op', async () => {
        await saveRemoteDocument(DOC)
        assertEqual(syncStatus.peek(), 'synced', 'no status change without a session')
    })
})

describe('remoteSave push', () => {

    it('writes the document and adopts the token the write returns', async () => {
        const { store, writes } = fakeDocStore(async (_doc, attempt) => `token-${attempt}`)
        setRemoteSaveStore(store)

        await saveRemoteDocument(DOC)

        assertEqual(writes.length, 1, 'one push')
        assertEqual(writes[0].nodes[1].text, 'Hello', 'the document reached the store')
        assertEqual(syncStatus.peek(), 'synced', 'status settles on synced')
    })

    it('retries a network failure and succeeds on the next attempt', async () => {
        const { store, writes } = fakeDocStore(async (_doc, attempt) => {
            if (attempt === 1) throw new StoreError('network', 'offline')
            return `token-${attempt}`
        })
        setRemoteSaveStore(store)

        await saveRemoteDocument(DOC)

        assertEqual(writes.length, 2, 'retried once')
        assertEqual(syncStatus.peek(), 'synced', 'the retry settles the status')
    })

    it('does not retry a rejected request', async () => {
        const { store, writes } = fakeDocStore(async () => {
            throw new StoreError('invalid-input', 'rejected')
        })
        setRemoteSaveStore(store)

        await saveRemoteDocument(DOC)

        assertEqual(writes.length, 1, 'invalid input is not retried')
        assertEqual(syncStatus.peek(), 'error', 'the failure is surfaced')
    })

    it('defers the push while typing and clearDeferredPush cancels the retry', async () => {
        const { store, writes } = fakeDocStore(async () => 'token-1')
        setRemoteSaveStore(store)
        // `noteLocalWriteActivity` closes the typing gate for one debounce window.
        outline.dirtyDebounceTimeout = 30
        noteLocalWriteActivity()

        await saveRemoteDocument(DOC)
        assertEqual(writes.length, 0, 'nothing is pushed while the gate is closed')

        clearDeferredPush()
        await new Promise((resolve) => setTimeout(resolve, 120))
        assertEqual(writes.length, 0, 'the cancelled retry never runs')
    })
})
