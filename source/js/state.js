// ── State ─────────────────────────────────────────────────────────────────────
// Single mutable state object and localStorage persistence.

import { makeDoc, findNode } from './model.js';

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
    activeModal: null,
    searchOpen: false,
    searchQuery: '',
    markdownDraft: '',
    loginError: '',
    loginSuccess: '',
    loginMode: 'signin',
    currentUser: null,

    // Sync state
    pendingSync: false,
    lastSyncedVersion: parseInt(localStorage.getItem('sync_version') || '0'),
    lastSyncedDocJson: localStorage.getItem('sync_base') || null,
    syncStatus: 'idle',
    syncIntervalId: null,
    syncPaused: false,
    conflictLocal: null,
    conflictRemote: null,
    conflictResolved: null,
    conflictServerVersion: 0,
    devMode: localStorage.getItem('dev_mode') === 'true',
    encryptionKey: null,

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
        State.saveDocLocal();
    },

    saveDocLocal() {
        try {
            localStorage.setItem(State.STORAGE_KEY, JSON.stringify(State.doc));
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
