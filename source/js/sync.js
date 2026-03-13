// ── Sync ──────────────────────────────────────────────────────────────────────
// Supabase authentication and cloud sync.
// Login implies sync — there is no separate "enable sync" toggle.

import * as State from './state.js';
import { render, setSyncStatus, openModal, closeModal, setLoginMode, applyTheme, applyDevMode } from './view.js';
import { makeDoc, seedDoc, exportMarkdown, importMarkdown, findNode } from './model.js';
import { deriveKey, generateSalt } from './crypto.js';

// ── Supabase client ───────────────────────────────────────────────────────────

const supabaseClient = window.supabase
    ? window.supabase.createClient(State.SUPABASE_URL, State.SUPABASE_KEY)
    : null;

// ── Salt helpers ──────────────────────────────────────────────────────────────

function decodeSaltB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function encodeSalt(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

/** Resolve the encryption salt: local → server → generate new. */
async function resolveSalt(userId) {
    const localB64 = localStorage.getItem(State.ENCRYPTION_SALT_KEY);
    if (localB64) return { bytes: decodeSaltB64(localB64), b64: localB64 };

    if (supabaseClient) {
        const { data } = await supabaseClient
            .from(State.SYNC_TABLE).select('salt')
            .eq('user_id', userId).maybeSingle();
        if (data?.salt) {
            localStorage.setItem(State.ENCRYPTION_SALT_KEY, data.salt);
            return { bytes: decodeSaltB64(data.salt), b64: data.salt };
        }
    }

    const bytes = generateSalt();
    const b64 = encodeSalt(bytes);
    localStorage.setItem(State.ENCRYPTION_SALT_KEY, b64);
    return { bytes, b64 };
}

// ── Auth UI ───────────────────────────────────────────────────────────────────

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderAuthUI(user) {
    const authUI = document.getElementById('auth-ui');
    if (!authUI) return;
    if (user) {
        authUI.innerHTML =
            `<div class="auth-actions">` +
            `<div class="auth-user-email">${escapeHtml(user.email)}</div>` +
            `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">` +
            `<button class="btn btn-secondary" id="btn-sign-out">Sign out</button>` +
            `<button class="btn btn-danger" id="btn-delete-account">Delete account</button>` +
            `</div></div>`;
        document.getElementById('btn-sign-out').addEventListener('click', () => signOut());
        document.getElementById('btn-delete-account').addEventListener('click', () => deleteAccount());
    } else {
        authUI.innerHTML = `<button class="btn btn-secondary" id="btn-sign-in">Sign in</button>`;
        document.getElementById('btn-sign-in').addEventListener('click', () => {
            setLoginMode('signin');
            openModal('modal-login');
        });
    }
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
            State.setEncryptionKey(await deriveKey(password, salt.bytes));
            // Ensure salt is on server
            try {
                await supabaseClient.from(State.SYNC_TABLE).upsert(
                    { user_id: user.id, salt: salt.b64 },
                    { onConflict: 'user_id' }
                );
            } catch (e) {
                console.warn('Failed to store salt:', e);
            }
            startSync();
        } else {
            // No saved password — cannot derive key, sign out
            await signOut();
        }
    }

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
        renderAuthUI(session?.user);
        if (!session) {
            stopSync();
        } else if (State.encryptionKey) {
            startSync();
        }
    });
}

export async function handleLoginSubmit(loginMode) {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');
    const successDiv = document.getElementById('login-success');
    errorDiv.classList.add('hidden');
    successDiv.classList.add('hidden');

    if (!email || !password) {
        errorDiv.textContent = 'Email and password are required.';
        errorDiv.classList.remove('hidden');
        return;
    }

    // ── Sign up ───────────────────────────────────────────────────────────────
    if (loginMode === 'signup') {
        const confirmPassword = document.getElementById('login-confirm-password').value;
        if (password !== confirmPassword) {
            errorDiv.textContent = 'Passwords do not match.';
            errorDiv.classList.remove('hidden');
            return;
        }
        if (!supabaseClient) {
            errorDiv.textContent = 'Authentication service unavailable.';
            errorDiv.classList.remove('hidden');
            return;
        }
        const { error } = await supabaseClient.auth.signUp({ email, password });
        if (error) {
            errorDiv.textContent = error.message;
            errorDiv.classList.remove('hidden');
        } else {
            document.getElementById('login-email').value = '';
            document.getElementById('login-password').value = '';
            document.getElementById('login-confirm-password').value = '';
            successDiv.textContent = 'Check your email for a confirmation link.';
            successDiv.classList.remove('hidden');
        }
        return;
    }

    // ── Sign in ───────────────────────────────────────────────────────────────
    if (!supabaseClient) {
        errorDiv.textContent = 'Authentication service unavailable.';
        errorDiv.classList.remove('hidden');
        return;
    }

    // Warn that local data will be replaced
    if (State.doc.root.children.length > 0) {
        if (!confirm('Signing in will replace your local data with the server version. Continue?')) return;
    }

    const { data: signInData, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
        errorDiv.textContent = error.message;
        errorDiv.classList.remove('hidden');
        return;
    }

    const userId = signInData.user.id;

    // Derive encryption key
    const salt = await resolveSalt(userId);
    State.setEncryptionKey(await deriveKey(password, salt.bytes));
    localStorage.setItem(State.ENCRYPTION_PASSWORD_KEY, password);

    // Ensure salt is on server
    try {
        await supabaseClient.from(State.SYNC_TABLE).upsert(
            { user_id: userId, salt: salt.b64 },
            { onConflict: 'user_id' }
        )
    } catch (e) {
        console.warn('Failed to store salt:', e);
    }

    // Pull server data and overwrite local
    const { data: serverRow } = await supabaseClient
        .from(State.SYNC_TABLE)
        .select('data, version')
        .eq('user_id', userId)
        .maybeSingle();

    if (serverRow?.data) {
        try {
            const payload = await State.decryptPayload(serverRow.data);
            const remoteDoc = payload.doc || payload;
            State.setDoc(remoteDoc);
            State.saveDocLocal();
            if (payload.theme) {
                localStorage.setItem(State.THEME_KEY, payload.theme);
                applyTheme(payload.theme);
            }
            State.setLastSyncedVersion(serverRow.version);
            State.setLastSyncedDocJson(JSON.stringify(State.doc));
            localStorage.setItem(State.SYNC_VERSION_KEY, String(serverRow.version));
            localStorage.setItem(State.SYNC_BASE_KEY, JSON.stringify(State.doc));
        } catch (e) {
            console.error('Failed to decrypt server data on login:', e);
        }
    } else {
        // No server data — push local on next sync tick
        State.setLastSyncedVersion(0);
        State.setPendingSync(true);
    }

    State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
    render();

    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    closeModal('modal-login');
    startSync();
}

export async function signOut() {
    stopSync();
    State.setEncryptionKey(null);
    if (supabaseClient) await supabaseClient.auth.signOut();

    // Clear all localStorage
    localStorage.clear();

    // Reset to seed data
    const doc = makeDoc();
    seedDoc(doc);
    State.setDoc(doc);
    State.saveDocLocal();

    // Reset state
    State.setZoomStack([]);
    State.setLastSyncedVersion(0);
    State.setLastSyncedDocJson(null);
    State.setPendingSync(false);
    State.setDevMode(false);
    history.replaceState(null, '', '#');

    // Reset UI
    applyTheme('light');
    applyDevMode();
    render();
    renderAuthUI(null);
}

export async function deleteAccount() {
    if (!confirm('Delete your account? This will permanently remove all synced data and cannot be undone.')) return;
    try {
        const session = await getActiveSession();
        if (session) {
            await supabaseClient.from(State.SYNC_TABLE).delete().eq('user_id', session.user.id);
        }
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

    const syncPayload = { doc: State.doc, theme: localStorage.getItem(State.THEME_KEY) || 'light' };
    const compressed = await State.encryptPayload(syncPayload);
    const saltB64 = localStorage.getItem(State.ENCRYPTION_SALT_KEY);

    const { error } = await supabaseClient.from(State.SYNC_TABLE).upsert({
        user_id: userId,
        data: compressed,
        version: newVersion,
        updated_at: new Date().toISOString(),
        ...(saltB64 ? { salt: saltB64 } : {})
    }, { onConflict: 'user_id' });

    if (error) throw error;

    State.setPendingSync(false);
    State.setLastSyncedVersion(newVersion);
    State.setLastSyncedDocJson(JSON.stringify(State.doc));
    localStorage.setItem(State.SYNC_VERSION_KEY, String(newVersion));
    localStorage.setItem(State.SYNC_BASE_KEY, JSON.stringify(State.doc));
    setSyncStatus('synced');
}

async function pullFromServer(row) {
    const payload = await State.decryptPayload(row.data);
    const remoteDoc = payload.doc || payload;

    State.setDoc(remoteDoc);
    State.saveDocLocal();

    if (payload.theme) {
        localStorage.setItem(State.THEME_KEY, payload.theme);
        applyTheme(payload.theme);
    }

    State.setLastSyncedVersion(row.version);
    State.setLastSyncedDocJson(JSON.stringify(State.doc));
    localStorage.setItem(State.SYNC_VERSION_KEY, String(row.version));
    localStorage.setItem(State.SYNC_BASE_KEY, JSON.stringify(State.doc));
    State.setPendingSync(false);
    State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
    render();
    setSyncStatus('synced');
}

// ── 3-way merge & conflict handling ──────────────────────────────────────────

async function handleConflict(row) {
    let remotePayload;
    try {
        remotePayload = await State.decryptPayload(row.data);
    } catch {
        setSyncStatus('error');
        State.setSyncPaused(false);
        return;
    }
    const remoteDoc = remotePayload.doc || remotePayload;

    const { tryAutoMerge } = await import('./model.js');
    const merged = tryAutoMerge(State.doc, remoteDoc, State.lastSyncedDocJson);

    if (merged) {
        // Auto-merge succeeded — apply and push immediately
        State.setDoc(merged);
        State.saveDocLocal();
        State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
        render();
        State.setSyncPaused(false);
        await pushToServer(row.user_id, row.version);
        return;
    }

    // Manual conflict resolution
    State.setConflictRemoteDoc(remoteDoc);
    State.setConflictServerVersion(row.version);

    document.getElementById('conflict-local').value = exportMarkdown(State.doc.root).trim();
    document.getElementById('conflict-remote').value = exportMarkdown(remoteDoc.root).trim();
    document.getElementById('conflict-resolved').value = exportMarkdown(State.doc.root).trim();

    setSyncStatus('conflict');
    openModal('modal-conflict');
    // syncPaused stays true until user resolves
}

// ── Conflict modal resolution ─────────────────────────────────────────────────

export async function handleConflictUseLocal() {
    closeModal('modal-conflict');
    State.setSyncPaused(false);
    const session = await getActiveSession();
    if (session) {
        setSyncStatus('syncing');
        try { await pushToServer(session.user.id, State.conflictServerVersion); }
        catch { setSyncStatus('error'); }
    } else {
        setSyncStatus('idle');
    }
}

export async function handleConflictUseRemote() {
    closeModal('modal-conflict');
    State.setSyncPaused(false);
    if (State.conflictRemoteDoc) {
        State.setDoc(State.conflictRemoteDoc);
        State.saveDocLocal();
        State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
        render();
    }
    State.setLastSyncedVersion(State.conflictServerVersion);
    State.setLastSyncedDocJson(JSON.stringify(State.doc));
    localStorage.setItem(State.SYNC_VERSION_KEY, String(State.conflictServerVersion));
    localStorage.setItem(State.SYNC_BASE_KEY, JSON.stringify(State.doc));
    State.setPendingSync(false);
    setSyncStatus('synced');
}

export async function handleConflictApply(text) {
    if (!text.trim()) return;
    const newRoot = importMarkdown(text);
    State.doc.root.children = newRoot.children;
    State.saveDocLocal();
    closeModal('modal-conflict');
    State.setSyncPaused(false);
    State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
    render();
    const session = await getActiveSession();
    if (session) {
        setSyncStatus('syncing');
        try { await pushToServer(session.user.id, State.conflictServerVersion); }
        catch { setSyncStatus('error'); }
    } else {
        setSyncStatus('idle');
    }
}

// ── Sync loop ─────────────────────────────────────────────────────────────────
// Every 15 s:
//   1. Query server version.
//   2. If server version <= local version → push local (if pending changes).
//   3. If server version > local version → pull, try merge, push.

export async function syncNow() {
    if (State.syncPaused) return;
    if (!State.encryptionKey) return;

    const session = await getActiveSession();
    if (!session) return;

    setSyncStatus('syncing');
    try {
        const { data: versionRow, error: vErr } = await supabaseClient
            .from(State.SYNC_TABLE).select('version')
            .eq('user_id', session.user.id).maybeSingle();
        if (vErr) throw vErr;

        const serverVersion = versionRow?.version || 0;

        if (serverVersion <= State.lastSyncedVersion) {
            // Server same or older — push if needed
            const neverSynced = State.lastSyncedVersion === 0 && serverVersion === 0
                && State.doc.root.children.length > 0;
            if (State.pendingSync || neverSynced) {
                await pushToServer(session.user.id, serverVersion);
            } else {
                setSyncStatus('synced');
            }
            return;
        }

        // Server is newer — pull
        const { data: dataRow, error: fErr } = await supabaseClient
            .from(State.SYNC_TABLE).select('data')
            .eq('user_id', session.user.id).maybeSingle();
        if (fErr) throw fErr;

        if (!dataRow?.data) {
            setSyncStatus('synced');
            return;
        }

        const row = { ...dataRow, version: serverVersion, user_id: session.user.id };
        State.setSyncPaused(true);

        try {
            if (!State.pendingSync) {
                // No local changes — just pull
                await pullFromServer(row);
                State.setSyncPaused(false);
            } else {
                // Local changes — try auto-merge or open conflict modal
                await handleConflict(row);
            }
        } catch (e) {
            State.setSyncPaused(false);
            throw e;
        }
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
        State.setSyncPaused(false);
    }
}

export function startSync() {
    if (!State.encryptionKey) return;
    if (State.syncIntervalId) return;
    syncNow();
    State.setSyncIntervalId(setInterval(syncNow, State.SYNC_INTERVAL_MS));
}

export function stopSync() {
    if (State.syncIntervalId) {
        clearInterval(State.syncIntervalId);
        State.setSyncIntervalId(null);
    }
    State.setSyncPaused(false);
    setSyncStatus('idle');
}
