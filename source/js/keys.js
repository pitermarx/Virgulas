// ── Key helpers ──────────────────────────────────────────────────────────────
// Shared keyboard predicate helpers for app/update layers.

export const isCmdKey = (e, key) => (e.ctrlKey || e.metaKey) && e.key === key;
export const isPlainKey = (e, key) => e.key === key && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
export const isArrowKey = (e, key) => e.key === key && !e.altKey && !e.ctrlKey && !e.metaKey;
export const isArrowNoMods = (e, key) => isArrowKey(e, key) && !e.shiftKey;
