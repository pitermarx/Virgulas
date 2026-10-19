import outline from '../../../source/js/outline.js'
import {
    createRemoteSyncAttempt,
    isRemoteSyncAttemptStale,
    canStartRemoteSync,
    remoteSyncRetryDelay,
    noteLocalWriteActivity,
    runExclusiveRemoteSync,
    setLastSyncedAt,
    getLastSyncedAt,
    getLastSyncHead,
    setSyncHead
} from '../../../source/js/sync.js'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

const harness = createAsyncSectionHarness({ beforeEach: () => outline.reset() })
export const sections = harness.sections
const section = harness.section
const test = harness.test

section('sync attempt lifecycle')

await test('debounce window blocks then allows a new sync attempt', () => {
    outline.dirtyDebounceTimeout = 100
    const base = Date.now() + 1_000_000

    noteLocalWriteActivity(base)
    assertEqual(canStartRemoteSync(base), false, 'blocked during debounce')
    assertEqual(canStartRemoteSync(base + outline.dirtyDebounceTimeout + 1), true, 'allowed after debounce')
})

await test('a new local write invalidates an in-flight attempt', () => {
    outline.dirtyDebounceTimeout = 50
    const base = Date.now() + 2_000_000

    noteLocalWriteActivity(base)
    const attempt = createRemoteSyncAttempt()
    const afterDebounce = base + 51
    assertEqual(isRemoteSyncAttemptStale(attempt, afterDebounce), false, 'attempt is fresh')

    noteLocalWriteActivity(afterDebounce)
    assertEqual(isRemoteSyncAttemptStale(attempt, afterDebounce + 51), true, 'attempt stale after new write')
})

await test('null attempts are always stale', () => {
    assertEqual(isRemoteSyncAttemptStale(null), true, 'null attempt')
})

// Placed last in this section: `remoteSyncNotBefore` is monotonic for the whole
// suite, and this uses the largest offset so it cannot affect earlier cases.
await test('remoteSyncRetryDelay reports how long a push is deferred', () => {
    outline.dirtyDebounceTimeout = 200
    const base = Date.now() + 100_000_000

    noteLocalWriteActivity(base)
    // This is what lets a deferred push be rescheduled instead of dropped.
    assertEqual(remoteSyncRetryDelay(base), 200, 'full window remaining at the write')
    assertEqual(remoteSyncRetryDelay(base + 120), 80, 'counting down mid-window')
    assertEqual(remoteSyncRetryDelay(base + 200), 0, 'ready exactly at the boundary')
    assertEqual(remoteSyncRetryDelay(base + 500), 0, 'never negative once ready')
})

await test('an attempt without mutations stays fresh until a write invalidates it', () => {
    // Late in this section the typing gate sits far in the future from earlier
    // tests, so everything here runs at a large offset.
    const t = Date.now() + 1_000_000_000
    const attempt = createRemoteSyncAttempt()
    assertEqual(isRemoteSyncAttemptStale(attempt, t), false, 'fresh attempt')
    noteLocalWriteActivity(t)
    assertEqual(isRemoteSyncAttemptStale(attempt, t + outline.dirtyDebounceTimeout + 1), true, 'stale after new write')
})

section('runExclusiveRemoteSync')

await test('serialises concurrent work in submission order', async () => {
    outline.dirtyDebounceTimeout = 0
    const order: number[] = []
    const first = runExclusiveRemoteSync(async () => {
        order.push(1)
        await new Promise((resolve) => setTimeout(resolve, 15))
        order.push(2)
    })
    const second = runExclusiveRemoteSync(async () => {
        order.push(3)
    })
    await Promise.all([first, second])
    assertEqual(order.join(','), '1,2,3', 'second work waits for the first')
})

await test('a rejected job does not break the queue', async () => {
    await runExclusiveRemoteSync(async () => { throw new Error('boom') }).catch(() => { })
    const result = await runExclusiveRemoteSync(async () => 'ok')
    assertEqual(result, 'ok', 'queue still usable')
})

section('lastSyncedAt helpers')

await test('round-trips through the store', () => {
    setLastSyncedAt(4242)
    assertEqual(getLastSyncedAt(), 4242, 'value persisted')
})

await test('defaults to 0 when nothing has been stored', () => {
    localStorage.removeItem('vmd_sync_ts')
    assertEqual(getLastSyncedAt(), 0, 'default 0')
})

section('sync head helpers')

await test('the sync head token round-trips and clears', () => {
    localStorage.removeItem('vmd_sync_head')
    assertEqual(getLastSyncHead(), null, 'no token initially')
    setSyncHead('token-abc')
    assertEqual(getLastSyncHead(), 'token-abc', 'token stored')
    setSyncHead(null)
    assertEqual(getLastSyncHead(), null, 'token cleared')
})
