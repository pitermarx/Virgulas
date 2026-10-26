// The offline-cache decorator (docs/storage-interface.md §4.7, rollout PR 2b).
//
// Remote mode is really two stores: the backend (source of truth) and the
// local cache slot, which is what makes offline mid-session operation and a
// correct lock screen on offline boot work. cached() makes that pairing a
// composition. Both sides share the one KeySession (§4.3), so the two copies
// always carry the same salt and envelope.
//
// It does NOT make offline *unlock* work: unlock is primary-only, so an
// offline Remote reload fails at the lock screen exactly as today (OQ 8 is a
// future capability, not a decorator side effect).
//
// The write tee holds plaintext strings for milliseconds only; the
// orchestration's deferred-push queue holds documents, never ciphertext
// (Goal 2) — a flush just re-runs write().

import { StoreError, type StringStore } from './storage.js'

export interface CachedOptions {
    /**
     * Receives every cache write outcome: null on success, the error on
     * failure. When provided, a cache failure no longer fails the whole write
     * — the primary still runs and the caller owns the local-failure surface
     * (data-06: Remote mode reports "not saved locally" while the server copy
     * is current). Without it the historical contract stands: the primary is
     * attempted, then the cache error propagates.
     */
    onCacheWrite?(error: unknown | null): void
}

export function cached(primary: StringStore, cache: StringStore, options: CachedOptions = {}): StringStore {
    return {
        async write(text) {
            // Cache first, then primary (today's local-save-then-push order).
            // A cache quota failure does not skip the primary: the save is
            // durable remotely and the failure is reported separately.
            let cacheError: unknown = null
            try {
                await cache.write(text)
                options.onCacheWrite?.(null)
            } catch (error) {
                cacheError = error
                options.onCacheWrite?.(error)
            }
            const token = await primary.write(text)
            if (cacheError && !options.onCacheWrite) throw cacheError
            return token
        },

        async read() {
            try {
                return await primary.read()
            } catch (error) {
                // Mid-session connectivity loss reads from the cache. The
                // fallback may be stale — a merge against a stale self-copy is
                // a no-op merge. Only 'network' falls back: remote-rekeyed and
                // every other typed error propagate untouched.
                if (error instanceof StoreError && error.code === 'network') {
                    return await cache.read()
                }
                throw error
            }
        },

        async clear() {
            await cache.clear()
            await primary.clear()
        },

        async exists() {
            // Offline boot must still show the lock screen.
            return await cache.exists() || await primary.exists()
        },

        async head() {
            // Change detection is about the source of truth (today's
            // checkRemoteNewer catch lives in the orchestration).
            return primary.head?.() ?? null
        },

        async unlock(passphrase) {
            // Primary only: today's unlockRemote verifies against the remote
            // record, and an offline Remote reload needs connectivity.
            await primary.unlock?.(passphrase)
        },

        async lock() {
            // One shared KeySession — locking it locks both sides.
            await primary.lock?.()
            await cache.lock?.()
        },

        capabilities: { ...primary.capabilities }
    }
}
