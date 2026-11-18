import { signal } from '@preact/signals'

function readAppVersion(): string {
    if (typeof document === 'undefined') return 'dev'
    const value = document
        .querySelector('meta[name="app-version"]')
        ?.getAttribute('content')
        ?.trim()
    return value || 'dev'
}

/** App version from the shell meta tag; shown in the Options footer. */
export const appVersion = signal(readAppVersion())

/**
 * Diagnostic logging, used for internal inconsistency warnings. Off unless
 * `localStorage.vmd_debug === '1'`, so the diagnostics stay available without
 * shipping a developer panel.
 */
export function log(...args: unknown[]) {
    try {
        if (localStorage.getItem('vmd_debug') === '1') console.log('[debug]', ...args)
    } catch {
        /* storage unavailable */
    }
}

export const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

export interface BrowserCapabilities {
    cryptoSubtle: boolean
    compressionStreams: boolean
    localStorage: boolean
    indexedDB: boolean
}

type BrowserApiProbe = {
    crypto?: { subtle?: unknown } | null
    CompressionStream?: unknown
    DecompressionStream?: unknown
    localStorage?: unknown
    indexedDB?: unknown
}

export function detectBrowserCapabilities(apis: BrowserApiProbe = globalThis as BrowserApiProbe): BrowserCapabilities {
    let localStorageAvailable = false
    let indexedDBAvailable = false
    try {
        localStorageAvailable = Boolean(apis.localStorage)
    } catch { }
    try {
        indexedDBAvailable = Boolean(apis.indexedDB)
    } catch { }

    return {
        cryptoSubtle: Boolean(apis.crypto?.subtle),
        compressionStreams: typeof apis.CompressionStream === 'function' && typeof apis.DecompressionStream === 'function',
        localStorage: localStorageAvailable,
        indexedDB: indexedDBAvailable
    }
}

export function supportsEncryptedStorage(capabilities: BrowserCapabilities): boolean {
    return capabilities.cryptoSubtle && capabilities.compressionStreams && capabilities.localStorage
}

export interface StoragePersistenceApi {
    persist?: () => Promise<boolean>
    persisted?: () => Promise<boolean>
}

function getStoragePersistenceApi(): StoragePersistenceApi | null {
    return typeof navigator === 'undefined' ? null : navigator.storage
}

export async function isStoragePersistent(storage = getStoragePersistenceApi()): Promise<boolean> {
    try {
        return storage?.persisted ? await storage.persisted() : false
    } catch {
        return false
    }
}

export async function requestPersistentStorage(storage = getStoragePersistenceApi()): Promise<boolean> {
    try {
        if (!storage) return false
        if (storage.persisted && await storage.persisted()) return true
        return storage.persist ? await storage.persist() : false
    } catch {
        return false
    }
}

/**
 * Deletes every Cache Storage entry this app owns. The service worker caches the
 * app shell and static assets under versioned `virgulas-*` cache names; the
 * navigations handler now normalises every navigation to the single `./index.html`
 * key, but any cache written by an older build (or by a URL still holding capture
 * text in its query string) would otherwise survive a purge on a shared device.
 * Matching the `virgulas-` prefix means a future `sw:bump` version change cannot
 * strand an old cache either.
 *
 * Best-effort: no-ops where the Cache Storage API is unavailable (insecure
 * contexts, some privacy modes) and never throws into a purge flow.
 */
/**
 * Ask the service worker to pause and finish its cache writes, then later to
 * resume them. A stale-while-revalidate write started just before a purge can
 * land after `caches.delete` and recreate the cache the purge just removed.
 *
 * Best-effort: no controller (first visit, insecure context, tests) returns at
 * once, and an unresponsive worker is abandoned after one second.
 */
async function messageServiceWorker(type: 'drain-cache-writes' | 'resume-cache-writes'): Promise<void> {
    const controller = typeof navigator === 'undefined' ? null : navigator.serviceWorker?.controller
    if (!controller) return
    if (type === 'resume-cache-writes') {
        controller.postMessage({ type })
        return
    }
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
            clearTimeout(timer)
            resolve()
        }
        controller.postMessage({ type }, [channel.port2])
    })
}

export async function clearAppCaches(cacheStorage: CacheStorage | undefined = typeof caches === 'undefined' ? undefined : caches): Promise<void> {
    if (!cacheStorage) return
    await messageServiceWorker('drain-cache-writes')
    try {
        // Re-check after deleting: a CacheStorage delete can fail transiently
        // (the API rejects with UnknownError under load), and a purge that
        // silently leaves the cache behind is worse than one extra pass.
        for (let attempt = 0; attempt < 3; attempt++) {
            const names = (await cacheStorage.keys()).filter((name) => name.startsWith('virgulas-'))
            if (names.length === 0) break
            await Promise.all(names.map((name) => cacheStorage.delete(name)))
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50))
        }
    } catch (error) {
        log('[Cache] Failed to clear app caches:', error)
    } finally {
        await messageServiceWorker('resume-cache-writes')
    }
}

function readStorage(key: string, fallback: string | null = null): string | null {
    try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value
    } catch (error) {
        log(`[Storage] Failed to read ${key}:`, error)
        return fallback
    }
}

function writeStorage(key: string, value: string | null | undefined): boolean {
    try {
        if (value === null || value === undefined) {
            localStorage.removeItem(key)
            return true
        }
        localStorage.setItem(key, value)
        return true
    } catch (error) {
        log(`[Storage] Failed to write ${key}:`, error)
        return false
    }
}

function deleteStorage(key: string): boolean {
    try {
        localStorage.removeItem(key)
        return true
    } catch (error) {
        log(`[Storage] Failed to remove ${key}:`, error)
        return false
    }
}

function slot(key: string) {
    return {
        get(fallback: string | null = null): string | null {
            return readStorage(key, fallback)
        },
        set(value: string | null | undefined): boolean {
            return writeStorage(key, value)
        },
        del(): boolean {
            return deleteStorage(key)
        }
    }
}

export type StoreSlot = ReturnType<typeof slot>

/**
 * A slot for a provider-owned key that predates the namespaced slots — only
 * the Supabase SDK's `sb-<project-ref>-auth-token` keys, which old builds let
 * the SDK write directly to localStorage. Nothing reads them any more; the
 * device wipe uses this helper to delete them so "Delete local data" is
 * complete on browsers that signed in before the migration (priv-01).
 */
export function legacySlot(key: string): StoreSlot {
    return slot(key)
}

/**
 * Removes Supabase SDK session keys written directly to localStorage by builds
 * that predate `store.supabaseSession`. New sessions live in the slot; this
 * sweep keeps a device wipe complete for browsers that signed in before the
 * migration (priv-01).
 */
export function clearLegacySupabaseSessions(): void {
    try {
        const keys: string[] = []
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index)
            if (key && key.startsWith('sb-') && key.includes('-auth-token')) keys.push(key)
        }
        for (const key of keys) legacySlot(key).del()
    } catch (error) {
        log('[Storage] Failed to clear legacy Supabase sessions:', error)
    }
}

/**
 * Backend configuration slot (storage seam, docs §8): the pinned backend
 * config in the current `{ backend, url?, key? }` shape.
 */
export const store = {
    theme: slot('vmd_theme'),
    mode: slot('vmd_last_mode'),
    user: slot('vmd_last_username'),
    data: slot('vmd_data_enc'),
    backend: slot('backendconfig'),
    syncTs: slot('vmd_sync_ts'),
    syncHead: slot('vmd_sync_head'),
    backendSession: slot('vmd_backend_session'),
    supabaseSession: slot('vmd_supabase_session'),
    scheduledWindow: slot('vmd_scheduled_window'),
    inboxNodeName: slot('vmd_inbox_node_name'),
    inboxQueue: slot('vmd_inbox_queue'),
    storageNoticeDismissed: slot('vmd_storage_notice_dismissed')
}