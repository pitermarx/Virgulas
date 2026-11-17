// The four storage modes' UI traits and copy, in one place.
//
// Behavioural branches (the unlock path, polling, the save edge) stay in their
// modules; this is the knowledge every surface would otherwise re-derive from
// the mode string — labels, whether a passphrase exists, whether the document
// leaves the device, and the Options danger wording.

import type { PersistenceMode } from './persistence.js'
import type { BrowserCapabilities } from './utils.js'

/** A stored mode string, or null when it is not one of the four modes. */
export function normalizeMode(mode: unknown): PersistenceMode | null {
    return mode === 'local' || mode === 'remote' || mode === 'filesystem' || mode === 'memory' ? mode : null
}

/** The warning shown when the browser cannot support the selected encrypted mode. */
export function describeBrowserSupport(capabilities: BrowserCapabilities, encryptedStorageAvailable: boolean): string {
    const warnings: string[] = []
    if (!encryptedStorageAvailable) {
        const missing = []
        if (!capabilities.cryptoSubtle) missing.push('Web Crypto')
        if (!capabilities.compressionStreams) missing.push('Compression Streams')
        if (!capabilities.localStorage) missing.push('localStorage')
        warnings.push(`Encrypted Local and Remote storage are unavailable because this browser lacks ${missing.join(', ')}. If either mode was selected, the app will continue in Memory without changing the saved mode or encrypted document.`)
    }
    if (!capabilities.indexedDB) {
        warnings.push('IndexedDB is unavailable, so file handles will not be remembered between visits and biometric unlock is unavailable.')
    }
    return warnings.join(' ')
}

export interface ModeSpec {
    /** Toolbar, lock screen and wizard label. */
    label: string
    /** The document is passphrase-encrypted (Local/Remote). */
    encrypted: boolean
    /** The document lives off this device, behind an account (Remote). */
    synced: boolean
    /** Suffix after the raw mode in the Options summary. */
    detail: string
    /** Options danger-button label. */
    action: string
    /** Confirm prompt for the danger button. */
    prompt: string
}

export const modes: Record<PersistenceMode, ModeSpec> = {
    memory: {
        label: 'Memory',
        encrypted: false,
        synced: false,
        detail: ' · in-memory only',
        action: 'Delete local data',
        prompt: 'Delete local data? This removes the encrypted outline, the quick-capture queue, and all remembered session data. This cannot be undone.'
    },
    local: {
        label: 'Local',
        encrypted: true,
        synced: false,
        detail: ' · encrypted',
        action: 'Delete local data',
        prompt: 'Delete local data? This removes the encrypted outline, the quick-capture queue, and all remembered session data. This cannot be undone.'
    },
    remote: {
        label: 'Remote',
        encrypted: true,
        synced: true,
        detail: ' · encrypted',
        action: 'Sign out',
        prompt: 'Clear browser session and sign out? Your remote data on the server is unaffected.'
    },
    filesystem: {
        label: 'File',
        encrypted: false,
        synced: false,
        detail: ' · not encrypted',
        action: 'Clear file session',
        prompt: 'Clear the remembered file handle and local session? Your .vmd file on disk is unaffected.'
    }
}

export const modeLabel = (mode: PersistenceMode) => modes[mode].label
export const isEncryptedMode = (mode: PersistenceMode) => modes[mode].encrypted
