// ── Sync ──────────────────────────────────────────────────────────────────────
// Supabase authentication and cloud sync.

import State from './state.js';
import { render, renderAuthUI, setSyncStatus, openModal, closeModal, applyTheme, applyDevMode, byId, setHidden, setText } from './view.js';
import { makeDoc, seedDoc, exportMarkdown, importMarkdown } from './model.js';
import { deriveKey, generateSalt, bytesToB64, b64ToBytes } from './crypto.js';

// ── Supabase client ───────────────────────────────────────────────────────────

const supabaseClient = window.supabase
    ? window.supabase.createClient(State.SUPABASE_URL, State.SUPABASE_KEY)
    : null;

const syncTable = () => supabaseClient.from(State.SYNC_TABLE);
const syncRow = (userId, select) => syncTable().select(select).eq('user_id', userId).maybeSingle();

function clearLoginFields() {
    ['login-email', 'login-password', 'login-confirm-password'].forEach(id => {
        const el = byId(id);
        if (el) el.value = '';
    });
}

function showLoginMsg(id, message) {
    setText(id, message);
    setHidden(id, false);
}

function requireAuthService(showError) {
    if (supabaseClient) return true;
    showError('Authentication service unavailable.');
    return false;
}

function normalizeDoc(payload) {
    return payload?.doc || payload;
}

function applyRemoteDoc(remoteDoc) {
    State.replaceDoc(remoteDoc, { save: true });
    render();
}

async function ensureSaltOnServer(userId, saltB64) {
    if (!supabaseClient || !saltB64) return;
    try {
        await syncTable().upsert(
            { user_id: userId, salt: saltB64 },
            { onConflict: 'user_id' }
        );
    } catch (e) {
        console.warn('Failed to store salt:', e);
    }
}

async function pushConflictResolutionIfSession() {
    const session = await getActiveSession();
    if (!session) { setSyncStatus('idle'); return; }
    setSyncStatus('syncing');
    try {
        await pushToServer(session.user.id, State.conflictServerVersion);
    } catch { setSyncStatus('error'); }
}

// ── Salt helpers ──────────────────────────────────────────────────────────────

async function resolveSalt(userId) {
    const localB64 = localStorage.getItem(State.ENCRYPTION_SALT_KEY);
    if (localB64) return { bytes: b64ToBytes(localB64), b64: localB64 };

    if (supabaseClient) {
        const { data } = await syncRow(userId, 'salt');
        if (data?.salt) {
            localStorage.setItem(State.ENCRYPTION_SALT_KEY, data.salt);
            return { bytes: b64ToBytes(data.salt), b64: data.salt };
        }
    }

    const bytes = generateSalt();
    const b64 = bytesToB64(bytes);
    localStorage.setItem(State.ENCRYPTION_SALT_KEY, b64);
    return { bytes, b64 };
}

// ── Auth lifecycle ────────────────────────────────────────────────────────────

export async function initAuth() {
    renderAuthUI(null);
    if (!supabaseClient) return;

    const { data } = await supabaseClient.auth.getSession();
    const user = data.session?.user;
    renderAuthUI(user);

    if (user) {
        const password = localStorage.getItem(State.ENCRYPTION_PASSWORD_KEY);
        if (password) {
            const salt = await resolveSalt(user.id);
            State.encryptionKey = await deriveKey(password, salt.bytes);
            await ensureSaltOnServer(user.id, salt.b64);
            startSync();
        } else {
            await signOut();
        }
    }

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
        renderAuthUI(session?.user);
        if (!session) stopSync();
        else if (State.encryptionKey) startSync();
    });
}

export async function handleLoginSubmit(loginMode) {
    const email = byId('login-email').value.trim();
    const password = byId('login-password').value;
    setHidden('login-error', true);
    setHidden('login-success', true);

    const showError = (msg) => showLoginMsg('login-error', msg);
    const showSuccess = (msg) => showLoginMsg('login-success', msg);

    if (!email || !password) { showError('Email and password are required.'); return; }

    // Sign up
    if (loginMode === 'signup') {
        const confirmPassword = byId('login-confirm-password').value;
        if (password !== confirmPassword) { showError('Passwords do not match.'); return; }
        if (!requireAuthService(showError)) return;
        const { error } = await supabaseClient.auth.signUp({ email, password });
        if (error) showError(error.message);
        else { clearLoginFields(); showSuccess('Check your email for a confirmation link.'); }
        return;
    }

    // Sign in
    if (!requireAuthService(showError)) return;
    if (State.doc.root.children.length > 0) {
        if (!confirm('Signing in will replace your local data with the server version. Continue?')) return;
    }

    const { data: signInData, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) { showError(error.message); return; }

    const userId = signInData.user.id;
    const salt = await resolveSalt(userId);
    State.encryptionKey = await deriveKey(password, salt.bytes);
    localStorage.setItem(State.ENCRYPTION_PASSWORD_KEY, password);
    await ensureSaltOnServer(userId, salt.b64);

    const { data: serverRow } = await syncRow(userId, 'data, version');

    if (serverRow?.data) {
        try {
            applyRemoteDoc(normalizeDoc(await State.decryptPayload(serverRow.data)));
            State.updateSyncSnapshot(serverRow.version);
        } catch (e) { console.error('Failed to decrypt server data on login:', e); }
    } else {
        State.lastSyncedVersion = 0;
        State.pendingSync = true;
        render();
    }
    clearLoginFields();
    closeModal('modal-login');
    startSync();
}

export async function signOut() {
    stopSync();
    State.encryptionKey = null;
    if (supabaseClient) await supabaseClient.auth.signOut();
    localStorage.clear();

    const doc = makeDoc();
    seedDoc(doc);
    State.replaceDoc(doc, { save: true });

    State.zoomStack = [];
    State.lastSyncedVersion = 0;
    State.lastSyncedDocJson = null;
    State.pendingSync = false;
    State.devMode = false;
    history.replaceState(null, '', '#');

    applyTheme('light');
    applyDevMode();
    render();
    renderAuthUI(null);
}

export async function deleteAccount() {
    if (!confirm('Delete your account? This will permanently remove all synced data and cannot be undone.')) return;
    try {
        const session = await getActiveSession();
        if (session) await syncTable().delete().eq('user_id', session.user.id);
        await signOut();
    } catch (e) {
        console.error('Delete account error:', e);
        alert('Failed to delete account data. Please try again.');
    }
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function getActiveSession() {
    if (!supabaseClient) return null;
    const { data } = await supabaseClient.auth.getSession();
    return data.session || null;
}

// ── Push / pull ───────────────────────────────────────────────────────────────

async function pushToServer(userId, baseServerVersion) {
    const newVersion = Math.max(State.doc.version || 1, baseServerVersion) + 1;
    State.doc.version = newVersion;
    State.saveDocLocal();

    const saltB64 = localStorage.getItem(State.ENCRYPTION_SALT_KEY);
    const { error } = await syncTable().upsert({
        user_id: userId,
        data: await State.encryptPayload(State.doc),
        version: newVersion,
        updated_at: new Date().toISOString(),
        ...(saltB64 ? { salt: saltB64 } : {})
    }, { onConflict: 'user_id' });
    if (error) throw error;

    State.pendingSync = false;
    State.updateSyncSnapshot(newVersion);
    setSyncStatus('synced');
}

async function pullFromServer(row) {
    applyRemoteDoc(normalizeDoc(await State.decryptPayload(row.data)));
    State.updateSyncSnapshot(row.version);
    State.pendingSync = false;
    setSyncStatus('synced');
}

// ── Conflict handling ─────────────────────────────────────────────────────────

async function handleConflict(row) {
    let remotePayload;
    try { remotePayload = await State.decryptPayload(row.data); }
    catch { setSyncStatus('error'); State.syncPaused = false; return; }
    const remoteDoc = normalizeDoc(remotePayload);

    const { tryAutoMerge } = await import('./model.js');
    const merged = tryAutoMerge(State.doc, remoteDoc, State.lastSyncedDocJson);

    if (merged) {
        applyRemoteDoc(merged);
        State.syncPaused = false;
        await pushToServer(row.user_id, row.version);
        return;
    }

    State.conflictRemoteDoc = remoteDoc;
    State.conflictServerVersion = row.version;
    byId('conflict-local').value = exportMarkdown(State.doc.root).trim();
    byId('conflict-remote').value = exportMarkdown(remoteDoc.root).trim();
    byId('conflict-resolved').value = exportMarkdown(State.doc.root).trim();
    setSyncStatus('conflict');
    openModal('modal-conflict');
}

export async function handleConflictUseLocal() {
    closeModal('modal-conflict');
    State.syncPaused = false;
    await pushConflictResolutionIfSession();
}

export async function handleConflictUseRemote() {
    closeModal('modal-conflict');
    State.syncPaused = false;
    if (State.conflictRemoteDoc) applyRemoteDoc(State.conflictRemoteDoc);
    State.updateSyncSnapshot(State.conflictServerVersion);
    State.pendingSync = false;
    setSyncStatus('synced');
}

export async function handleConflictApply(text) {
    if (!text.trim()) return;
    State.doc.root.children = importMarkdown(text).children;
    State.saveDocLocal();
    closeModal('modal-conflict');
    State.syncPaused = false;
    State.sanitizeZoomStack();
    render();
    await pushConflictResolutionIfSession();
}

// ── Sync loop ─────────────────────────────────────────────────────────────────

export async function syncNow() {
    if (State.syncPaused || !State.encryptionKey) return;
    const session = await getActiveSession();
    if (!session) return;

    setSyncStatus('syncing');
    try {
        const { data: versionRow, error: vErr } = await syncRow(session.user.id, 'version');
        if (vErr) throw vErr;

        const serverVersion = versionRow?.version || 0;

        if (serverVersion <= State.lastSyncedVersion) {
            const neverSynced = State.lastSyncedVersion === 0 && serverVersion === 0
                && State.doc.root.children.length > 0;
            if (State.pendingSync || neverSynced) await pushToServer(session.user.id, serverVersion);
            else setSyncStatus('synced');
            return;
        }

        const { data: dataRow, error: fErr } = await syncRow(session.user.id, 'data');
        if (fErr) throw fErr;
        if (!dataRow?.data) { setSyncStatus('synced'); return; }

        const row = { ...dataRow, version: serverVersion, user_id: session.user.id };
        State.syncPaused = true;
        try {
            if (!State.pendingSync) {
                await pullFromServer(row);
                State.syncPaused = false;
            } else {
                await handleConflict(row);
            }
        } catch (e) { State.syncPaused = false; throw e; }
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
        State.syncPaused = false;
    }
}

export function startSync() {
    if (!State.encryptionKey || State.syncIntervalId) return;
    syncNow();
    State.syncIntervalId = setInterval(syncNow, State.SYNC_INTERVAL_MS);
}

export function stopSync() {
    if (State.syncIntervalId) {
        clearInterval(State.syncIntervalId);
        State.syncIntervalId = null;
    }
    State.syncPaused = false;
    setSyncStatus('idle');
}
