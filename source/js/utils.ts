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
    inboxQueue: slot('vmd_inbox_queue')
}