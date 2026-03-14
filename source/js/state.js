// ── State ─────────────────────────────────────────────────────────────────────
// Single mutable state object and localStorage persistence.

import { makeDoc, findNode } from './model.js';
import { bytesToB64, b64ToBytes } from './crypto.js';

const State = {
    // Constants
    STORAGE_KEY: 'outline_v1',
    THEME_KEY: 'theme',
    SYNC_VERSION_KEY: 'sync_version',
    SYNC_BASE_KEY: 'sync_base',
    DEV_MODE_KEY: 'dev_mode',
    ENCRYPTION_SALT_KEY: 'encryption_salt',
    ENCRYPTION_PASSWORD_KEY: 'encryption_password',
    SYNC_TABLE: 'outlines',
    SYNC_INTERVAL_MS: 15000,
    SUPABASE_URL: 'https://__SUPABASE_PROJECT__.supabase.co',
    SUPABASE_KEY: '__SUPABASE_PUBLISHABLE_DEFAULT_KEY__',

    // Document state
    doc: makeDoc(),
    zoomStack: [],
    focusedId: null,
    searchMatches: [],
    searchIdx: 0,
    undoStack: [],
    selectedIds: [],
    selectionAnchor: null,
    selectionHead: null,
    keepSelection: false,

    // Sync state
    pendingSync: false,
    lastSyncedVersion: parseInt(localStorage.getItem('sync_version') || '0'),
    lastSyncedDocJson: localStorage.getItem('sync_base') || null,
    syncStatus: 'idle',
    syncIntervalId: null,
    syncPaused: false,
    conflictRemoteDoc: null,
    conflictServerVersion: 0,
    devMode: localStorage.getItem('dev_mode') === 'true',
    encryptionKey: null,

    // Callbacks (wired by app.js)
    onSyncStatusUpdate: null,
    onDocSaved: null,

    // Derived
    getZoomRoot() {
        const last = State.zoomStack[State.zoomStack.length - 1];
        return last ? (findNode(last, State.doc.root) || State.doc.root) : State.doc.root;
    },

    sanitizeZoomStack() {
        State.zoomStack = State.zoomStack.filter(id => !!findNode(id, State.doc.root));
    },

    replaceDoc(doc, { save = false } = {}) {
        State.doc = doc;
        State.sanitizeZoomStack();
        if (save) State.saveDocLocal();
    },

    updateSyncSnapshot(version) {
        const json = JSON.stringify(State.doc);
        State.lastSyncedVersion = version;
        State.lastSyncedDocJson = json;
        localStorage.setItem(State.SYNC_VERSION_KEY, String(version));
        localStorage.setItem(State.SYNC_BASE_KEY, json);
    },

    // Persistence
    saveDoc() {
        State.pendingSync = true;
        if (State.syncStatus === 'synced' || State.syncStatus === 'idle') {
            State.syncStatus = 'pending';
            State.onSyncStatusUpdate?.('pending');
        }
        State._persist();
    },

    saveDocLocal() { State._persist(); },

    _persist() {
        try {
            localStorage.setItem(State.STORAGE_KEY, JSON.stringify(State.doc));
            State.onDocSaved?.();
        } catch { }
    },

    loadDoc() {
        try {
            const raw = localStorage.getItem(State.STORAGE_KEY);
            if (raw) {
                State.replaceDoc(JSON.parse(raw));
                return true;
            }
        } catch { }
        return false;
    },

    pushUndo() {
        State.undoStack.push(JSON.stringify(State.doc));
        if (State.undoStack.length > 100) State.undoStack.shift();
    },

    // Compression
    async compressData(obj) {
        const stream = new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(obj))); c.close(); }
        }).pipeThrough(new CompressionStream('gzip'));
        return bytesToB64(new Uint8Array(await new Response(stream).arrayBuffer()));
    },

    async decompressData(b64) {
        try {
            const stream = new ReadableStream({
                start(c) { c.enqueue(b64ToBytes(b64)); c.close(); }
            }).pipeThrough(new DecompressionStream('gzip'));
            return JSON.parse(await new Response(stream).text());
        } catch {
            return JSON.parse(atob(b64));
        }
    },

    async encryptPayload(obj) {
        const compressed = await State.compressData(obj);
        if (State.encryptionKey) {
            const { encrypt } = await import('./crypto.js');
            return encrypt(State.encryptionKey, compressed);
        }
        return compressed;
    },

    async decryptPayload(data) {
        if (State.encryptionKey) {
            try {
                const { decrypt } = await import('./crypto.js');
                return State.decompressData(await decrypt(State.encryptionKey, data));
            } catch { }
        }
        return State.decompressData(data);
    },

    // URL / history
    updateHash() {
        history.pushState(null, '', State.zoomStack.length ? '#/' + State.zoomStack.join('/') : '#');
    },

    loadFromHash() {
        const hash = location.hash.replace(/^#\/?/, '');
        State.zoomStack = hash
            ? hash.split('/').filter(Boolean).filter(id => !!findNode(id, State.doc.root))
            : [];
    },
};

export default State;
