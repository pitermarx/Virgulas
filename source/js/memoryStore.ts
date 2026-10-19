// Memory adapter (docs/storage-interface.md §5, rollout PR 2a).
// RAM-only string store: the Memory-mode backend. The document dies with the
// reload, so its change token (a monotonic counter) is session-scoped and
// never persisted — there is nothing to detect across reloads.

import type { StringStore } from './storage.js'

export function memoryStore(): StringStore {
    let value: string | null = null
    let counter = 0

    return {
        async read() {
            return value
        },
        async write(text) {
            value = text
            counter += 1
            return String(counter)
        },
        async clear() {
            value = null
            counter += 1
            return
        },
        async exists() {
            return value !== null
        },
        async head() {
            return value === null ? null : String(counter)
        },
        capabilities: {
            durable: 'never',
            encrypted: false,
            authenticated: false,
            changeDetection: true,
            available: true
        }
    }
}
