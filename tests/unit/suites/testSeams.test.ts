// struct-06: the Playwright seams must be inert outside the test bundle, so a
// same-origin script cannot zero the retry backoff or the poll interval in
// production (it could otherwise hammer the backend in a loop).
import { describe, it, afterEach } from 'bun:test'
import { assert, assertEqual } from '../testing.js'
import { resolveRetryBaseMs } from '../../../source/js/remoteSave.js'
import { resolvePollIntervalMs } from '../../../source/js/sync.js'

afterEach(() => {
    delete (window as any).__retryBaseMs
    delete (window as any).__syncPollIntervalMs
    delete (globalThis as any).__TEST_HOOKS__
})

describe('test seams are build-gated (struct-06)', () => {
    it('the retry base ignores window.__retryBaseMs outside the test bundle', () => {
        ;(window as any).__retryBaseMs = 1
        assertEqual(resolveRetryBaseMs(), 500, 'a production build keeps the default backoff')
    })

    it('the poll interval ignores window.__syncPollIntervalMs outside the test bundle', () => {
        ;(window as any).__syncPollIntervalMs = 1
        assertEqual(resolvePollIntervalMs(), 60_000, 'a production build keeps the default poll')
    })

    it('the test bundle still reads both overrides', () => {
        ;(globalThis as any).__TEST_HOOKS__ = true
        ;(window as any).__retryBaseMs = 1
        ;(window as any).__syncPollIntervalMs = 100
        assertEqual(resolveRetryBaseMs(), 1, 'the retry seam is live in the test bundle')
        assertEqual(resolvePollIntervalMs(), 100, 'the poll seam is live in the test bundle')
    })

    it('the production poll interval cannot become a hammering cadence', () => {
        assert(resolvePollIntervalMs() >= 5_000, 'poll floor')
    })
})
