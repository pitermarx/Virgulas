// ── State ─────────────────────────────────────────────────────────────────────
// Mutable application state and localStorage persistence.
// This is the "Model instance" in the Elm-inspired architecture — the single
// source of truth for all runtime state.

import { makeDoc, findNode } from './model.js';

// ── Storage keys ──────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'outline_v1';
export const THEME_KEY = 'theme';
export const SYNC_VERSION_KEY = 'sync_version';
export const SYNC_BASE_KEY = 'sync_base';
export const SYNC_ENABLED_KEY = 'sync_enabled';
export const DEV_MODE_KEY = 'dev_mode';
export const SYNC_TABLE = 'outlines';
export const SYNC_INTERVAL_MS = 15000;

// ── Supabase credentials ──────────────────────────────────────────────────────

export const SUPABASE_URL = 'https://fpuoxiiedqmcfnjubicz.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_qz7yiLLNFBOKG8S7PfiluQ_vn-SKnd8';

// ── Document state ────────────────────────────────────────────────────────────

export let doc = makeDoc();
export let zoomStack = [];       // array of node IDs
export let focusedId = null;
export let searchMatches = [];
export let searchIdx = 0;
export let undoStack = [];
export let selectedIds = [];     // IDs of all currently selected nodes
export let selectionAnchor = null;
export let selectionHead = null;
export let _keepSelection = false;

// ── Sync state ────────────────────────────────────────────────────────────────

export let pendingSync = false;
export let lastSyncedVersion = parseInt(localStorage.getItem(SYNC_VERSION_KEY) || '0');
export let lastSyncedDocJson = localStorage.getItem(SYNC_BASE_KEY) || null;
export let syncStatus = 'idle';
export let syncIntervalId = null;
export let conflictRemoteDoc = null;
export let conflictServerVersion = 0;
export let syncEnabled = localStorage.getItem(SYNC_ENABLED_KEY) === 'true';
export let devMode = localStorage.getItem(DEV_MODE_KEY) === 'true';

// ── State setters (needed because ES module bindings are not directly settable) ─

export function setDoc(value) { doc = value; }
export function setZoomStack(value) { zoomStack = value; }
export function setFocusedId(value) { focusedId = value; }
export function setSearchMatches(value) { searchMatches = value; }
export function setSearchIdx(value) { searchIdx = value; }
export function setUndoStack(value) { undoStack = value; }
export function setSelectedIds(value) { selectedIds = value; }
export function setSelectionAnchor(value) { selectionAnchor = value; }
export function setSelectionHead(value) { selectionHead = value; }
export function setKeepSelection(value) { _keepSelection = value; }
export function setPendingSync(value) { pendingSync = value; }
export function setLastSyncedVersion(value) { lastSyncedVersion = value; }
export function setLastSyncedDocJson(value) { lastSyncedDocJson = value; }
export function setSyncStatusVar(value) { syncStatus = value; }
export function setSyncIntervalId(value) { syncIntervalId = value; }
export function setConflictRemoteDoc(value) { conflictRemoteDoc = value; }
export function setConflictServerVersion(value) { conflictServerVersion = value; }
export function setSyncEnabled(value) { syncEnabled = value; }
export function setDevMode(value) { devMode = value; }

// ── Derived state ─────────────────────────────────────────────────────────────

export function getZoomRoot() {
    if (zoomStack.length === 0) return doc.root;
    return findNode(zoomStack[zoomStack.length - 1], doc.root) || doc.root;
}

// ── Sync status DOM callback ──────────────────────────────────────────────────
// Set by app.js to allow state.js to trigger DOM updates without importing view.js

let _onSyncStatusUpdate = null;
export function setSyncStatusCallback(fn) { _onSyncStatusUpdate = fn; }

// ── Persistence ───────────────────────────────────────────────────────────────

export function saveDoc() {
    pendingSync = true;
    if (syncStatus === 'synced' || syncStatus === 'idle') {
        setSyncStatusVar('pending');
        _onSyncStatusUpdate?.('pending');
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch (e) { }
}

export function saveDocLocal() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    } catch (e) { }
}

export function loadDoc() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            doc = JSON.parse(raw);
            return true;
        }
    } catch (e) { }
    return false;
}

export function pushUndo() {
    undoStack.push(JSON.stringify(doc));
    if (undoStack.length > 100) undoStack.shift();
}

// ── Compression ───────────────────────────────────────────────────────────────

export async function compressData(obj) {
    const json = JSON.stringify(obj);
    const encoded = new TextEncoder().encode(json);
    const stream = new ReadableStream({
        start(ctrl) { ctrl.enqueue(encoded); ctrl.close(); }
    }).pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export async function decompressData(b64) {
    try {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const stream = new ReadableStream({
            start(ctrl) { ctrl.enqueue(bytes); ctrl.close(); }
        }).pipeThrough(new DecompressionStream('gzip'));
        return JSON.parse(await new Response(stream).text());
    } catch {
        return JSON.parse(atob(b64));
    }
}

// ── URL / history ─────────────────────────────────────────────────────────────

export function updateHash() {
    const hash = zoomStack.length > 0 ? '#/' + zoomStack.join('/') : '#';
    history.pushState(null, '', hash);
}

export function loadFromHash() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (!hash) { zoomStack = []; return; }
    const ids = hash.split('/').filter(Boolean);
    zoomStack = ids.filter(id => !!findNode(id, doc.root));
}
