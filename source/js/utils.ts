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
export async function clearAppCaches(cacheStorage: CacheStorage | undefined = typeof caches === 'undefined' ? undefined : caches): Promise<void> {
    if (!cacheStorage) return
    try {
        const names = await cacheStorage.keys()
        await Promise.all(
            names
                .filter((name) => name.startsWith('virgulas-'))
                .map((name) => cacheStorage.delete(name))
        )
    } catch (error) {
        log('[Cache] Failed to clear app caches:', error)
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

export const store = {
    theme: slot('vmd_theme'),
    mode: slot('vmd_last_mode'),
    user: slot('vmd_last_username'),
    data: slot('vmd_data_enc'),
    supabase: slot('supabaseconfig'),
    syncTs: slot('vmd_sync_ts'),
    scheduledWindow: slot('vmd_scheduled_window'),
    inboxNodeName: slot('vmd_inbox_node_name'),
    inboxQueue: slot('vmd_inbox_queue'),
    storageNoticeDismissed: slot('vmd_storage_notice_dismissed')
}