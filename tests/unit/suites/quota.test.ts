// Document-size quota suite: the budget-relative level thresholds (browser
// quota or a plan cap), the notice state machine (dismissal per level,
// re-arm on escalation, reset on shrink, re-derivation when a plan budget
// arrives), the byte formatter, and the slotRaw observer that feeds it.

import { describe, it, beforeEach } from 'bun:test'
import { slotRaw } from '../../../source/js/localStore.js'
import { store } from '../../../source/js/utils.js'
import {
    BROWSER_QUOTA_BYTES,
    activeBudgetBytes,
    dismissSlotQuotaNotice,
    formatBytes,
    noteSlotChars,
    resetSlotQuotaState,
    setDocumentBudget,
    slotLevel,
    slotQuotaLevel,
    slotQuotaNotice
} from '../../../source/js/quota.js'
import { assert, assertEqual } from '../testing.js'

describe('slotLevel — budget-relative thresholds', () => {
    it('levels at 60% and 97% of whatever budget binds', () => {
        const plan = 1_048_576
        assertEqual(slotLevel(0, plan), 'ok', 'zero is ok')
        assertEqual(slotLevel(plan * 0.6 - 1, plan), 'ok', 'just below warn')
        assertEqual(slotLevel(plan * 0.6, plan), 'near', 'at warn')
        assertEqual(slotLevel(plan * 0.97 - 1, plan), 'near', 'just below critical')
        assertEqual(slotLevel(plan * 0.97, plan), 'full', 'at critical')
    })

    it('defaults to the browser quota; a plan budget becomes the binding budget', () => {
        resetSlotQuotaState()
        assertEqual(activeBudgetBytes(), BROWSER_QUOTA_BYTES, 'browser default')
        assertEqual(slotLevel(3_100_000), 'near', '62% of the browser quota')
        setDocumentBudget(1_048_576)
        assertEqual(activeBudgetBytes(), 1_048_576, 'plan budget')
        assertEqual(slotLevel(3_100_000), 'full', 'the same usage is over 97% of the plan')
        resetSlotQuotaState()
    })
})

describe('formatBytes — MB-first human units', () => {
    it('renders B, KB and MB', () => {
        assertEqual(formatBytes(890), '890 B', 'bytes')
        assertEqual(formatBytes(656_000), '641 KB', 'kilobytes')
        assertEqual(formatBytes(2_500_000), '2.4 MB', 'megabytes')
    })
})

describe('noteSlotChars — notice state machine', () => {
    beforeEach(() => {
        resetSlotQuotaState()
    })

    it('stays silent while the usage is small', () => {
        noteSlotChars(1000)
        assertEqual(slotQuotaNotice.value, 'ok', 'no notice below warn')
        assertEqual(slotQuotaLevel.value, 'ok', 'level ok')
    })

    it('warns at near; a dismissal is remembered for that level', () => {
        noteSlotChars(3_000_000)
        assertEqual(slotQuotaNotice.value, 'near', 'notice at warn')
        dismissSlotQuotaNotice()
        assertEqual(slotQuotaNotice.value, 'ok', 'dismissed')
        assertEqual(slotQuotaLevel.value, 'near', 'level unchanged by dismissal')
        // A later save at the same level does not nag again.
        noteSlotChars(3_100_000)
        assertEqual(slotQuotaNotice.value, 'ok', 'same level stays dismissed')
        assertEqual(store.quotaDismissed.get(null), 'near', 'dismissal persisted')
    })

    it('escalating to full re-arms a dismissed near notice', () => {
        noteSlotChars(3_000_000)
        dismissSlotQuotaNotice()
        noteSlotChars(4_850_000)
        assertEqual(slotQuotaNotice.value, 'full', 'escalation re-arms')
    })

    it('shrinking below the dismissed level resets the dismissal', () => {
        noteSlotChars(4_850_000)
        dismissSlotQuotaNotice()
        // A purge clears the slot.
        noteSlotChars(0)
        assertEqual(slotQuotaLevel.value, 'ok', 'level ok after clear')
        // The document regrew past warn: it warns once more, not forever silenced.
        noteSlotChars(3_000_000)
        assertEqual(slotQuotaNotice.value, 'near', 'warns again after shrinking')
    })

    it('a dismissed full level stays quiet while the document stays full', () => {
        noteSlotChars(4_850_000)
        dismissSlotQuotaNotice()
        noteSlotChars(4_860_000)
        assertEqual(slotQuotaNotice.value, 'ok', 'no repeated nagging at full')
    })

    it('a plan budget arriving after the usage re-derives level and notice', () => {
        noteSlotChars(700_000)
        assertEqual(slotQuotaNotice.value, 'ok', '14% of the browser quota: silent')
        setDocumentBudget(1_048_576)
        assertEqual(slotQuotaLevel.value, 'near', '67% of the plan cap: near')
        assertEqual(slotQuotaNotice.value, 'near', 'the notice follows the new budget')
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
