import { signal } from '@preact/signals'

function readAppVersion() {
    if (typeof document === 'undefined') return 'dev'
    const value = document
        .querySelector('meta[name="app-version"]')
        ?.getAttribute('content')
        ?.trim()
    return value || 'dev'
}

export const appVersion = signal(readAppVersion())

// ── Developer panel open/close toggle ────────────────────────────────────────
export const devPanelOpen = signal(false)

// ── Sync diagnostics ─────────────────────────────────────────────────────────
export const devSync = {
    lastSyncAt: signal(0),          // epoch ms of last successful remote sync
    lastSyncDurationMs: signal(0),  // ms taken by last full sync cycle
    retryCount: signal(0),          // cumulative retry count across all push attempts
    lastError: signal(''),          // last sync error message
    conflictCount: signal(0),       // total conflicts seen since page load
    pollRunCount: signal(0),        // number of background polls executed
}

// ── Crypto timings ────────────────────────────────────────────────────────────
export const devCrypto = {
    lastEncryptMs: signal(0),   // ms for last encrypt call
    lastDecryptMs: signal(0),   // ms for last decrypt call
}

// ── Outline stats (computed on demand by recordOutlineStats) ─────────────────
export const devOutline = {
    nodeCount: signal(0),
    maxDepth: signal(0),
    wordCount: signal(0),
    charCount: signal(0),
    collapsedCount: signal(0),
    openCount: signal(0),
}

// ── Persistence / unlock diagnostics ─────────────────────────────────────────
export const devPersistence = {
    unlockMode: signal(''),        // 'memory' | 'local' | 'remote' | 'filesystem'
    unlockDurationMs: signal(0),   // ms taken to unlock
    hashApplied: signal(false),    // whether applyHashZoomIfPresent found a valid node
}

// ── Storage quota (populated on panel open) ──────────────────────────────────
export const devStorage = {
    usageBytes: signal(0),
    quotaBytes: signal(0),
}

export async function refreshStorageQuota() {
    if (!navigator.storage?.estimate) return
    try {
        const { usage, quota } = await navigator.storage.estimate()
        devStorage.usageBytes.value = usage || 0
        devStorage.quotaBytes.value = quota || 0
    } catch { /* ignore */ }
}
