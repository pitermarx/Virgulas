import { describe, it, beforeEach, afterEach } from 'bun:test'
import outline from '../../../source/js/outline.js'
import {
    allowImmediateRemoteSync,
    createRemoteSyncAttempt,
    getRemoteStore,
    getLastSyncHead,
    noteLocalWriteActivity,
    pendingConflicts,
    pendingMergedDoc,
    setLastSyncedAt,
    setRemoteStore,
    setSyncHead,
    skipNextRemotePush,
    syncOnce,
    syncStatus
} from '../../../source/js/syncEngine.js'
import { StoreError, type DocStore, type StoreCapabilities } from '../../../source/js/storage.js'
import type { OutlineDoc, OutlineNode } from '../../../source/js/model.js'
import { assert, assertEqual } from '../testing.js'

const CAPABILITIES: StoreCapabilities = {
    durable: 'always',
    encrypted: true,
    authenticated: true,
    changeDetection: true,
    available: true
}

const BASE = 100

function node(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
    return { parentId: 'root', text: '', description: '', children: [], open: true, lastModified: 0, ...overrides }
}

function doc(nodes: OutlineNode[]): OutlineDoc {
    return { modelVersion: 'v1', dataVersion: 1, nodes }
}

/** Local: root with a and b. */
const LOCAL: OutlineDoc = doc([
    node({ id: 'root', parentId: null, children: ['a', 'b'], lastModified: 0 }),
    node({ id: 'a', text: 'A', lastModified: 0 }),
    node({ id: 'b', text: 'B', lastModified: 0 })
])

interface FakeStore {
    store: DocStore
    writes: OutlineDoc[]
    headCalls: () => number
}

function fakeStore(config: {
    remote?: OutlineDoc | null
    head?: string | null
    write?: (doc: OutlineDoc, attempt: number) => Promise<string | null>
} = {}): FakeStore {
    const writes: OutlineDoc[] = []
    let headCalls = 0
    return {
        writes,
        headCalls: () => headCalls,
        store: {
            async read() { return config.remote ?? null },
            async write(next) {
                writes.push(next)
                return config.write ? config.write(next, writes.length) : `token-${writes.length}`
            },
            async clear() { },
            async exists() { return true },
            async head() { headCalls++; return config.head ?? null },
            async unlock() { },
            async lock() { },
            capabilities: CAPABILITIES
        }
    }
}

function loadLocal(local: OutlineDoc = LOCAL) {
    outline.deserialize(JSON.stringify(local))
}

beforeEach(() => {
    setRemoteStore(null)
    setSyncHead(null)
    setLastSyncedAt(BASE)
    skipNextRemotePush.value = false
    pendingConflicts.value = []
    pendingMergedDoc.value = null
    syncStatus.value = 'synced'
    allowImmediateRemoteSync()
    loadLocal()
})

afterEach(() => {
    setRemoteStore(null)
    skipNextRemotePush.value = false
    pendingConflicts.value = []
    pendingMergedDoc.value = null
    syncStatus.value = 'synced'
    outline.reset()
})

describe('syncOnce — no work', () => {

    it('reports no-remote without a session', async () => {
        const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })
        assertEqual(outcome.kind, 'skipped', 'nothing runs')
        assertEqual((outcome as any).reason, 'no-remote', 'because there is no store')
    })

    it('skips while the typing gate is closed', async () => {
        const fake = fakeStore()
        setRemoteStore(fake.store)
        // `dirtyDebounceTimeout` is global model state; another suite may have
        // shortened it. Pin a gate that cannot expire inside this test, even
        // when the runner deschedules the process between the calls.
        const savedDebounce = outline.dirtyDebounceTimeout
        outline.dirtyDebounceTimeout = 60_000
        try {
            noteLocalWriteActivity()

            const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })

            assertEqual((outcome as any).reason, 'typing', 'deferred, not pushed')
            assertEqual(fake.writes.length, 0, 'nothing reaches the server')
            assertEqual(fake.headCalls(), 0, 'not even a head probe')
        } finally {
            outline.dirtyDebounceTimeout = savedDebounce
        }
    })

    it('skips an attempt superseded by a newer local write', async () => {
        const fake = fakeStore()
        setRemoteStore(fake.store)
        const attempt = createRemoteSyncAttempt()
        noteLocalWriteActivity()
        allowImmediateRemoteSync()

        const outcome = await syncOnce({ doc: LOCAL, attempt })

        assertEqual((outcome as any).reason, 'stale', 'the newer edit owns the push')
        assertEqual(fake.writes.length, 0, 'the stale document is not uploaded')
    })

    it('reports unchanged when the poll sees the same head token', async () => {
        const fake = fakeStore({ head: 'h1' })
        setRemoteStore(fake.store)
        setSyncHead('h1')

        const outcome = await syncOnce({ attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'unchanged', 'no remote change')
        assertEqual(fake.writes.length, 0, 'no write')
    })
})

describe('syncOnce — push', () => {

    it('uploads the document and adopts the returned token', async () => {
        const fake = fakeStore()
        setRemoteStore(fake.store)

        const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'pushed', 'direct push')
        assertEqual(fake.writes.length, 1, 'one upload')
        assertEqual(getLastSyncHead(), 'token-1', 'the new head is adopted')
        assertEqual(syncStatus.peek(), 'synced', 'status settles on synced')
        assert(getLastSyncHead() !== null, 'a token was recorded')
    })

    it('retries a network failure and succeeds on the next attempt', async () => {
        const fake = fakeStore({
            write: async (_doc, attempt) => {
                if (attempt === 1) throw new StoreError('network', 'offline')
                return `token-${attempt}`
            }
        })
        setRemoteStore(fake.store)
        Object.assign(globalThis, { __TEST_HOOKS__: true })
        window.__retryBaseMs = 1

        const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'pushed', 'the retry succeeds')
        assertEqual(fake.writes.length, 2, 'retried once')
        delete (globalThis as any).__TEST_HOOKS__
        window.__retryBaseMs = undefined
    })

    it('does not retry a rejected request and surfaces the failure', async () => {
        const fake = fakeStore({ write: async () => { throw new StoreError('invalid-input', 'rejected') } })
        setRemoteStore(fake.store)

        const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'failed', 'typed failure')
        assertEqual(fake.writes.length, 1, 'invalid input is not retried')
        assertEqual(syncStatus.peek(), 'error', 'the failure is surfaced')
    })

    it('pushes when the head moved but the remote row is gone', async () => {
        const fake = fakeStore({ head: 'h2', remote: null })
        setRemoteStore(fake.store)
        setSyncHead('h1')

        const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'pushed', 'the local document recreates the row')
        assertEqual(fake.writes.length, 1, 'one upload')
        assertEqual(getLastSyncHead(), 'token-1', 'the new head is adopted')
    })
})

describe('syncOnce — pull-before-push', () => {

    it('applies a newer remote without writing it back when content matches', async () => {
        const remote = doc([
            node({ id: 'root', parentId: null, children: ['a', 'b'], lastModified: 0 }),
            node({ id: 'a', text: 'A', lastModified: 200 }),
            node({ id: 'b', text: 'B', lastModified: 200 })
        ])
        // The live outline must hold the same content for the merge to match.
        loadLocal(remote)
        const fake = fakeStore({ head: 'h2', remote })
        setRemoteStore(fake.store)
        setSyncHead('h1')

        const outcome = await syncOnce({ attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'merged', 'the poll merged')
        assertEqual((outcome as any).pushed, false, 'the remote already holds this content')
        assertEqual(fake.writes.length, 0, 'no identical revision is created')
        assertEqual(getLastSyncHead(), 'h2', 'the observed token is adopted')
        assertEqual(syncStatus.peek(), 'synced', 'status settles')
    })

    it('merges, uploads the merged document and applies it locally', async () => {
        const local = doc([
            node({ id: 'root', parentId: null, children: ['a', 'b'], lastModified: 0 }),
            node({ id: 'a', text: 'A', lastModified: 0 }),
            node({ id: 'b', text: 'Local B', lastModified: 200 })
        ])
        const remote = doc([
            node({ id: 'root', parentId: null, children: ['a', 'b'], lastModified: 0 }),
            node({ id: 'a', text: 'Remote A', lastModified: 200 }),
            node({ id: 'b', text: 'B', lastModified: 0 })
        ])
        loadLocal(local)
        const fake = fakeStore({ head: 'h2', remote })
        setRemoteStore(fake.store)
        setSyncHead('h1')

        const outcome = await syncOnce({ attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'merged', 'clean merge')
        assertEqual((outcome as any).pushed, true, 'the merge differs from the remote copy')
        assertEqual(fake.writes.length, 1, 'one merged upload')
        const written = fake.writes[0].nodes
        assertEqual(written.find(n => n.id === 'a')?.text, 'Remote A', 'remote edit kept')
        assertEqual(written.find(n => n.id === 'b')?.text, 'Local B', 'local edit kept')
        assertEqual(outline.get('a')!.peek().text, 'Remote A', 'merged document applied locally')
        assertEqual(syncStatus.peek(), 'synced', 'status settles')
    })

    it('stops at a conflict and leaves the upload to the conflict flow', async () => {
        const local = doc([
            node({ id: 'root', parentId: null, children: ['a'], lastModified: 0 }),
            node({ id: 'a', text: 'Local', lastModified: 200 })
        ])
        const remote = doc([
            node({ id: 'root', parentId: null, children: ['a'], lastModified: 0 }),
            node({ id: 'a', text: 'Remote', lastModified: 300 })
        ])
        loadLocal(local)
        const fake = fakeStore({ head: 'h2', remote })
        setRemoteStore(fake.store)
        setSyncHead('h1')

        const outcome = await syncOnce({ doc: local, attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'conflict', 'the merge needs the user')
        assertEqual(fake.writes.length, 0, 'nothing is uploaded')
        assertEqual(pendingConflicts.peek().length, 1, 'the conflict is published')
        assert(pendingMergedDoc.peek() !== null, 'the partial document is kept for resolution')
    })

    it('never pushes around a pending conflict', async () => {
        const fake = fakeStore({ head: 'h2' })
        setRemoteStore(fake.store)
        pendingConflicts.value = [{ nodeId: 'a', nodeText: 'A', field: 'text', localValue: 'L', remoteValue: 'R' }]

        const outcome = await syncOnce({ doc: LOCAL, attempt: createRemoteSyncAttempt() })

        assertEqual(outcome.kind, 'conflict', 'the conflict owns the session')
        assertEqual(fake.writes.length, 0, 'no push')
        assertEqual(fake.headCalls(), 0, 'not even a head probe')
    })
})

describe('syncOnce — store ownership', () => {

    it('exposes the injected store and clears it on teardown', () => {
        const fake = fakeStore()
        setRemoteStore(fake.store)
        assertEqual(getRemoteStore(), fake.store, 'the engine holds the store')
        setRemoteStore(null)
        assertEqual(getRemoteStore(), null, 'teardown clears it')
    })
})
