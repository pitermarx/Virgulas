// Local slot adapter (docs/storage-interface.md §5, rollout PR 2a).
// The RawStore over a `store` slot in utils.ts (Rule 7: all localStorage access
// goes through those slots — this adapter is no exception). The at-rest shape
// is exactly today's `vmd_data_enc` value: `<salt>|<envelope>`; a value
// without the separator is legacy/corrupt and reads as "no record", matching
// today's `localEncryptedData` behaviour.
//
// The quota failure path (a failed slot write) surfaces as StoreError
// 'too-large' instead of being swallowed — the adapter-level half of the
// data-06 fix; the orchestration surfaces it when the cutover lands (PR 2c).

import { StoreError, type RawRecord, type RawStore, type StoreCapabilities } from './storage.js'
import { log, store } from './utils.js'

type Slot = typeof store.data

/** Non-cryptographic content hash (FNV-1a): change detection only, not security. */
function hashString(value: string): string {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(36)
}

export function slotRaw(slot: Slot): RawStore {
    const capabilities: StoreCapabilities = {
        durable: 'prompt',
        encrypted: false,
        authenticated: false,
        changeDetection: true,
        available: true
    }

    return {
        capabilities,

        async readRaw(): Promise<RawRecord | null> {
            const value = slot.get()
            if (!value) return null
            const separator = value.indexOf('|')
            if (separator === -1) {
                log('Invalid encrypted data format, missing "|" salt separator')
                return null
            }
            return { salt: value.slice(0, separator), data: value.slice(separator + 1) }
        },

        async writeRaw(record: RawRecord): Promise<string | null> {
            const value = record.salt ? `${record.salt}|${record.data}` : record.data
            if (!slot.set(value)) {
                // data-06: a quota failure must surface, not silently drop the save.
                throw new StoreError('too-large', 'The document does not fit in this browser\'s local storage.')
            }
            return hashString(value)
        },

        async clearRaw(): Promise<void> {
            slot.del()
        },

        async exists(): Promise<boolean> {
            return slot.get() !== null
        },

        async head(): Promise<string | null> {
            const value = slot.get()
            return value === null ? null : hashString(value)
        }
    }
}
