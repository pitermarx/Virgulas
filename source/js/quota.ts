// Document-size quota: the proactive guard before the document's storage
// budget fails a save (data-06's "not saved" toolbar state stays the
// reactive backstop). The budget is the binding allowance, not always the
// browser's: Local mode is bounded by the browser's storage quota, Remote
// mode by the account's plan cap (outline_plans, read through the storage
// seam after unlock). The measured usage is the stored slot (`vmd_data_enc`)
// — pure ASCII, so its character count is its byte count, and the same value
// the server row carries.
//
// Self-contained like durability.ts: persistence wires the observation
// (`slotRaw` reports every write, read and clear) and the remote plan budget,
// the toolbars render the usage ring, the app shell the notice banner.

import { signal } from '@preact/signals'
import { store } from './utils.js'

/**
 * The browser's per-origin localStorage quota, in bytes — the Local budget.
 * Conservatively cross-browser (Chrome ~5.24 M, Firefox and Safari ~5 M;
 * none of them expose the real quota). The slot is ASCII, so bytes ≈ chars.
 */
export const BROWSER_QUOTA_BYTES = 5_000_000

/** The usage share at which the dismissible reminder appears. */
export const BUDGET_WARN_FRACTION = 0.6
/** The usage share at which the next save is genuinely at risk. */
export const BUDGET_CRITICAL_FRACTION = 0.97

export type SlotQuotaLevel = 'ok' | 'near' | 'full'

/** The observed slot usage in bytes (0 until the first read or write). */
export const slotUsageBytes = signal(0)
/** The document's quota level — the truth, not the notice state. */
export const slotQuotaLevel = signal<SlotQuotaLevel>('ok')
/** The level currently surfaced as a notice; 'ok' means nothing is shown. */
export const slotQuotaNotice = signal<SlotQuotaLevel>('ok')
/**
 * The remote account's plan cap in bytes, set after a Remote unlock when the
 * backend reports one (Supabase's outline_plans); null keeps the budget at
 * the browser quota — Local mode, TrailBase, or a failed plan read.
 */
export const documentBudgetBytes = signal<number | null>(null)

const LEVEL_RANK: Record<SlotQuotaLevel, number> = { ok: 0, near: 1, full: 2 }

function normalizeLevel(value: string | null): SlotQuotaLevel {
    return value === 'near' || value === 'full' ? value : 'ok'
}

/** The persisted dismissal: the level whose notice the user already saw. */
let dismissedLevel = normalizeLevel(store.quotaDismissed.get(null))

/** The budget the usage is measured against. */
export function activeBudgetBytes(): number {
    return documentBudgetBytes.value ?? BROWSER_QUOTA_BYTES
}

/** Pure: the quota level for an observed usage against a budget. */
export function slotLevel(usage: number, budget: number = activeBudgetBytes()): SlotQuotaLevel {
    if (usage >= budget * BUDGET_CRITICAL_FRACTION) return 'full'
    if (usage >= budget * BUDGET_WARN_FRACTION) return 'near'
    return 'ok'
}

/** Bytes in human units, MB-first: 2.4 MB / 641 KB / 890 B. */
export function formatBytes(bytes: number): string {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
    return Math.round(bytes) + ' B'
}

/**
 * Record an observed slot usage: every slot write, every slot read (so an
 * already-large document warns at unlock, before any save), and clears (0).
 * Escalating past a dismissed level re-arms the notice — the new level is new
 * information — and dropping below the dismissed level resets it, so a
 * document that shrank and regrew warns once more instead of being silenced
 * forever.
 */
export function noteSlotChars(chars: number): void {
    slotUsageBytes.value = chars
    const level = slotLevel(chars)
    slotQuotaLevel.value = level
    if (LEVEL_RANK[level] < LEVEL_RANK[dismissedLevel]) {
        dismissedLevel = level
        store.quotaDismissed.set(level)
    }
    slotQuotaNotice.value = level === 'ok' || level === dismissedLevel ? 'ok' : level
}

/**
 * Set the remote account's plan cap (null: unknown, fall back to the browser
 * quota). The usage is usually known before the plan read resolves, so the
 * level is re-derived against the new budget.
 */
export function setDocumentBudget(bytes: number | null): void {
    documentBudgetBytes.value = bytes
    if (slotUsageBytes.peek() > 0) noteSlotChars(slotUsageBytes.peek())
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

/** Test seam: reset the persisted dismissal, the budget and the signals. */
export function resetSlotQuotaState(): void {
    dismissedLevel = 'ok'
    store.quotaDismissed.del()
    documentBudgetBytes.value = null
    slotUsageBytes.value = 0
    slotQuotaLevel.value = 'ok'
    slotQuotaNotice.value = 'ok'
}
