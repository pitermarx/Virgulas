import outline from '../../../source/js/outline.js'
import {
    createRemoteSyncAttempt,
    isRemoteSyncAttemptStale,
    canStartRemoteSync,
    noteLocalWriteActivity,
    beginRemotePush,
    recordCompletedRemotePush,
    runExclusiveRemoteSync,
    setLastSyncedAt,
    getLastSyncedAt,
    setCredentials,
    clearCredentials
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

await test('beginRemotePush records the start time and returns an ISO timestamp', () => {
    const attempt = createRemoteSyncAttempt()
    const iso = beginRemotePush(attempt, 5000)
    assertEqual(attempt.startedAt, 5000, 'startedAt set')
    assertEqual(new Date(iso).getTime(), 5000, 'ISO timestamp')
})

await test('recordCompletedRemotePush tolerates attempts without a start time', () => {
    recordCompletedRemotePush(createRemoteSyncAttempt())
    recordCompletedRemotePush(null)
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

section('credential helpers')

await test('set and clear credentials do not throw', () => {
    setCredentials('pass', 'salt')
    clearCredentials()
    assert(true, 'no throw')
})
