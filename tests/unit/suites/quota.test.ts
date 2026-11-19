// Document-size quota suite: the pure level thresholds, the notice state
// machine (dismissal per level, re-arm on escalation, reset on shrink), and
// the slotRaw observer that feeds it (write, read, clear).

import { describe, it, beforeEach } from 'bun:test'
import { slotRaw } from '../../../source/js/localStore.js'
import { store } from '../../../source/js/utils.js'
import {
    SLOT_CRITICAL_CHARS,
    SLOT_WARN_CHARS,
    dismissSlotQuotaNotice,
    noteSlotChars,
    resetSlotQuotaState,
    slotLevel,
    slotQuotaLevel,
    slotQuotaNotice
} from '../../../source/js/quota.js'
import { assert, assertEqual } from '../testing.js'

describe('slotLevel — pure thresholds', () => {
    it('levels exactly at the thresholds', () => {
        assertEqual(slotLevel(0), 'ok', 'zero is ok')
        assertEqual(slotLevel(SLOT_WARN_CHARS - 1), 'ok', 'just below warn')
        assertEqual(slotLevel(SLOT_WARN_CHARS), 'near', 'at warn')
        assertEqual(slotLevel(SLOT_CRITICAL_CHARS - 1), 'near', 'just below critical')
        assertEqual(slotLevel(SLOT_CRITICAL_CHARS), 'full', 'at critical')
    })
})

describe('noteSlotChars — notice state machine', () => {
    beforeEach(() => {
        resetSlotQuotaState()
    })

    it('stays silent while the slot is small', () => {
        noteSlotChars(1000)
        assertEqual(slotQuotaNotice.value, 'ok', 'no notice below warn')
        assertEqual(slotQuotaLevel.value, 'ok', 'level ok')
    })

    it('warns at near; a dismissal is remembered for that level', () => {
        noteSlotChars(SLOT_WARN_CHARS)
        assertEqual(slotQuotaNotice.value, 'near', 'notice at warn')
        dismissSlotQuotaNotice()
        assertEqual(slotQuotaNotice.value, 'ok', 'dismissed')
        assertEqual(slotQuotaLevel.value, 'near', 'level unchanged by dismissal')
        // A later save at the same level does not nag again.
        noteSlotChars(SLOT_WARN_CHARS + 1)
        assertEqual(slotQuotaNotice.value, 'ok', 'same level stays dismissed')
        assertEqual(store.quotaDismissed.get(null), 'near', 'dismissal persisted')
    })

    it('escalating to full re-arms a dismissed near notice', () => {
        noteSlotChars(SLOT_WARN_CHARS)
        dismissSlotQuotaNotice()
        noteSlotChars(SLOT_CRITICAL_CHARS)
        assertEqual(slotQuotaNotice.value, 'full', 'escalation re-arms')
    })

    it('shrinking below the dismissed level resets the dismissal', () => {
        noteSlotChars(SLOT_CRITICAL_CHARS)
        dismissSlotQuotaNotice()
        // A purge clears the slot.
        noteSlotChars(0)
        assertEqual(slotQuotaLevel.value, 'ok', 'level ok after clear')
        // The document regrew past warn: it warns once more, not forever silenced.
        noteSlotChars(SLOT_WARN_CHARS)
        assertEqual(slotQuotaNotice.value, 'near', 'warns again after shrinking')
    })

    it('a dismissed full level stays quiet while the document stays full', () => {
        noteSlotChars(SLOT_CRITICAL_CHARS)
        dismissSlotQuotaNotice()
        noteSlotChars(SLOT_CRITICAL_CHARS + 10)
        assertEqual(slotQuotaNotice.value, 'ok', 'no repeated nagging at full')
    })
})

describe('slotRaw observe — the adapter reports what it handled', () => {
    beforeEach(() => {
        resetSlotQuotaState()
        store.data.del()
    })

    it('reports the written length, the read length, and 0 on clear', async () => {
        const seen: number[] = []
        const raw = slotRaw(store.data, chars => { seen.push(chars) })
        await raw.writeRaw({ salt: 'AAAA', data: 'BBBB' })
        await raw.readRaw()
        await raw.clearRaw()
        assertEqual(seen.length, 3, 'one report per operation')
        assertEqual(seen[0], 'AAAA|BBBB'.length, 'written length')
        assertEqual(seen[1], 'AAAA|BBBB'.length, 'read length')
        assertEqual(seen[2], 0, 'clear reports zero')
    })

    it('a corrupt value (no salt separator) reports nothing', async () => {
        store.data.set('no-separator-here')
        const seen: number[] = []
        const raw = slotRaw(store.data, chars => { seen.push(chars) })
        const record = await raw.readRaw()
        assertEqual(record, null, 'corrupt value reads as no record')
        assertEqual(seen.length, 0, 'no observation for a corrupt value')
    })

    it('a failed write (quota exceeded) reports nothing and still throws too-large', async () => {
        const failingSlot = {
            get: () => null,
            set: () => false,
            del: () => true
        }
        const seen: number[] = []
        const raw = slotRaw(failingSlot as unknown as typeof store.data, chars => { seen.push(chars) })
        let threw: unknown = null
        try {
            await raw.writeRaw({ salt: 'AAAA', data: 'BBBB' })
        } catch (error) {
            threw = error
        }
        assert(threw !== null, 'failed write throws')
        assertEqual(seen.length, 0, 'no observation for a failed write')
    })
})
