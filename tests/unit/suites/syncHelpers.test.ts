import { describe, it, beforeEach } from 'bun:test'
import outline from '../../../source/js/outline.js'
import {
    createRemoteSyncAttempt,
    canStartRemoteSync,
    noteLocalWriteActivity,
    runExclusiveRemoteSync,
    setLastSyncedAt,
    getLastSyncedAt,
    getLastSyncHead,
    setSyncHead
} from '../../../source/js/syncEngine.js'
import { assertEqual } from '../testing.js'

beforeEach(() => outline.reset())


describe('sync attempt lifecycle', () => {

  it('debounce window blocks then allows a new sync attempt', () => {
      outline.dirtyDebounceTimeout = 100
      const base = Date.now() + 1_000_000

      noteLocalWriteActivity(base)
      assertEqual(canStartRemoteSync(base), false, 'blocked during debounce')
      assertEqual(canStartRemoteSync(base + outline.dirtyDebounceTimeout + 1), true, 'allowed after debounce')
  })

  it('a new local write starts a new epoch', () => {
      const before = createRemoteSyncAttempt()
      noteLocalWriteActivity()
      const after = createRemoteSyncAttempt()
      assertEqual(after.epoch, before.epoch + 1, 'each write opens a new epoch')
  })

})

describe('runExclusiveRemoteSync', () => {

  it('serialises concurrent work in submission order', async () => {
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

  it('a rejected job does not break the queue', async () => {
      await runExclusiveRemoteSync(async () => { throw new Error('boom') }).catch(() => { })
      const result = await runExclusiveRemoteSync(async () => 'ok')
      assertEqual(result, 'ok', 'queue still usable')
  })
})

describe('lastSyncedAt helpers', () => {

  it('round-trips through the store', () => {
      setLastSyncedAt(4242)
      assertEqual(getLastSyncedAt(), 4242, 'value persisted')
  })

  it('defaults to 0 when nothing has been stored', () => {
      localStorage.removeItem('vmd_sync_ts')
      assertEqual(getLastSyncedAt(), 0, 'default 0')
  })
})

describe('sync head helpers', () => {

  it('the sync head token round-trips and clears', () => {
      localStorage.removeItem('vmd_sync_head')
      assertEqual(getLastSyncHead(), null, 'no token initially')
      setSyncHead('token-abc')
      assertEqual(getLastSyncHead(), 'token-abc', 'token stored')
      setSyncHead(null)
      assertEqual(getLastSyncHead(), null, 'token cleared')
  })
})