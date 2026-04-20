let debug = new URLSearchParams(window.location.search).get('debug')

export function log(...args) {
    if (debug === 'true') {
        console.log('[debug]', ...args)
    }
}

export function enableDebug() {
    debug = 'true'
    log('Debug mode enabled')
    document.body.classList.add('debug')
}

if (debug) {
    enableDebug()
}

export const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

function readStorage(key, fallback = null) {
    try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value
    } catch (error) {
        log(`[Storage] Failed to read ${key}:`, error)
        return fallback
    }
}

function writeStorage(key, value) {
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

function deleteStorage(key) {
    try {
        localStorage.removeItem(key)
        return true
    } catch (error) {
        log(`[Storage] Failed to remove ${key}:`, error)
        return false
    }
}

function slot(key) {
    return {
        get(fallback = null) {
            return readStorage(key, fallback)
        },
        set(value) {
            return writeStorage(key, value)
        },
        del() {
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
    syncTs: slot('vmd_sync_ts')
}