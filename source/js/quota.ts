// Document-size quota: the proactive guard before the browser's storage
// quota fails a save (data-06's "not saved" toolbar state stays the
// reactive backstop). The measured unit is the stored slot (`vmd_data_enc`)
// in characters — exactly the string the browser's quota counts, and the
// same ASCII value the server row carries, so chars ≈ bytes.
//
// Self-contained like durability.ts: persistence wires the observation
// (`slotRaw` reports every write, read and clear), the app shell renders the
// notice, and nothing here knows the document or the stores.

import { signal } from '@preact/signals'
import { store } from './utils.js'

/**
 * The conservative cross-browser localStorage quota, in characters. Chrome
 * allows ~5.24 M per origin, Firefox and Safari ~5 M, and no browser exposes
 * the real quota, so 5 M is the honest planning number for a slot value that
 * is pure ASCII (`salt|v2:600000:<base64>`).
 */
export const SLOT_QUOTA_CHARS = 5_000_000

/** ~60%: a dismissible reminder (a dismissal is remembered per level). */
export const SLOT_WARN_CHARS = 3_000_000
/** ~97%: the next save is genuinely at risk of being rejected. */
export const SLOT_CRITICAL_CHARS = 4_850_000

export type SlotQuotaLevel = 'ok' | 'near' | 'full'

/** The observed slot length in characters (0 until the first read or write). */
export const slotChars = signal(0)
/** The document's quota level — the truth, not the notice state. */
export const slotQuotaLevel = signal<SlotQuotaLevel>('ok')
/** The level currently surfaced as a notice; 'ok' means nothing is shown. */
export const slotQuotaNotice = signal<SlotQuotaLevel>('ok')

const LEVEL_RANK: Record<SlotQuotaLevel, number> = { ok: 0, near: 1, full: 2 }

function normalizeLevel(value: string | null): SlotQuotaLevel {
    return value === 'near' || value === 'full' ? value : 'ok'
}

/** The persisted dismissal: the level whose notice the user already saw. */
let dismissedLevel = normalizeLevel(store.quotaDismissed.get(null))

/** Pure: the quota level for an observed slot length. */
export function slotLevel(chars: number): SlotQuotaLevel {
    if (chars >= SLOT_CRITICAL_CHARS) return 'full'
    if (chars >= SLOT_WARN_CHARS) return 'near'
    return 'ok'
}

/**
 * Record an observed slot length: every slot write, every slot read (so an
 * already-large document warns at unlock, before any save), and clears (0).
 * Escalating past a dismissed level re-arms the notice — the new level is new
 * information — and dropping below the dismissed level resets it, so a
 * document that shrank and regrew warns once more instead of being silenced
 * forever.
 */
export function noteSlotChars(chars: number): void {
    slotChars.value = chars
    const level = slotLevel(chars)
    slotQuotaLevel.value = level
    if (LEVEL_RANK[level] < LEVEL_RANK[dismissedLevel]) {
        dismissedLevel = level
        store.quotaDismissed.set(level)
    }
    slotQuotaNotice.value = level === 'ok' || level === dismissedLevel ? 'ok' : level
}

/** Dismiss the current notice: remembered per level, re-armed on escalation. */
export function dismissSlotQuotaNotice(): void {
    const level = slotQuotaLevel.peek()
    if (level !== 'ok') {
        dismissedLevel = level
        store.quotaDismissed.set(level)
    }
    slotQuotaNotice.value = 'ok'
}

/** Test seam: reset the persisted dismissal and the signals. */
export function resetSlotQuotaState(): void {
    dismissedLevel = 'ok'
    store.quotaDismissed.del()
    slotChars.value = 0
    slotQuotaLevel.value = 'ok'
    slotQuotaNotice.value = 'ok'
}
