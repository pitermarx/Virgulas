// ── Sync ──────────────────────────────────────────────────────────────────────
// Supabase authentication and cloud sync.
// This is the "side effects / commands" layer in the Elm-inspired architecture.

import * as State from './state.js';
import { render, setSyncStatus, openModal, closeModal, setLoginMode } from './view.js';
import { exportMarkdown, importMarkdown, findNode } from './model.js';

// ── Supabase client ───────────────────────────────────────────────────────────

const supabaseClient = window.supabase
    ? window.supabase.createClient(State.SUPABASE_URL, State.SUPABASE_KEY)
    : null;

// ── Auth UI ───────────────────────────────────────────────────────────────────

export function renderAuthUI(user) {
    const authUI = document.getElementById('auth-ui');
    if (!authUI) return;
    if (user) {
        authUI.innerHTML =
            `<div class="auth-actions">` +
            `<div class="auth-user-email">${user.email}</div>` +
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
    const currentUser = data.session ? data.session.user : null;
    renderAuthUI(currentUser);
    if (currentUser && State.syncEnabled) startSync();
    supabaseClient.auth.onAuthStateChange((_event, session) => {
        renderAuthUI(session ? session.user : null);
        if (session && State.syncEnabled) {
            startSync();
        } else {
            stopSync();
        }
    });
}

export async function signOut() {
    await supabaseClient.auth.signOut();
}

export async function deleteAccount() {
    if (!confirm('Delete your account? This will permanently remove all synced data and cannot be undone.')) return;
    try {
        const session = await getActiveSession();
        if (session) {
            await supabaseClient.from(State.SYNC_TABLE).delete().eq('user_id', session.user.id);
        }
        await supabaseClient.auth.signOut();
        localStorage.removeItem(State.SYNC_VERSION_KEY);
        localStorage.removeItem(State.SYNC_BASE_KEY);
        State.setLastSyncedVersion(0);
        State.setLastSyncedDocJson(null);
    } catch (e) {
        console.error('Delete account error:', e);
        alert('Failed to delete account data. Please try again.');
    }
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

    if (loginMode === 'signup') {
        const confirmPassword = document.getElementById('login-confirm-password').value;
        if (password !== confirmPassword) {
            errorDiv.textContent = 'Passwords do not match.';
            errorDiv.classList.remove('hidden');
            return;
        }
    }

    if (!supabaseClient) {
        errorDiv.textContent = 'Authentication service unavailable.';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (loginMode === 'signin') {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            errorDiv.textContent = error.message;
            errorDiv.classList.remove('hidden');
        } else {
            document.getElementById('login-email').value = '';
            document.getElementById('login-password').value = '';
            closeModal('modal-login');
        }
    } else {
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
    const compressed = await State.compressData(syncPayload);

    const { error } = await supabaseClient.from(State.SYNC_TABLE).upsert({
        user_id: userId,
        data: compressed,
        version: newVersion,
        updated_at: new Date().toISOString()
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
    const payload = await State.decompressData(row.data);
    const remoteDoc = payload.doc || payload;
    const remoteTheme = payload.theme;

    State.setDoc(remoteDoc);
    State.saveDocLocal();

    if (remoteTheme) {
        localStorage.setItem(State.THEME_KEY, remoteTheme);
        // applyTheme imported inline to avoid cycle with view.js at module level
        const { applyTheme } = await import('./view.js');
        applyTheme(remoteTheme);
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
        remotePayload = await State.decompressData(row.data);
    } catch {
        setSyncStatus('error');
        return;
    }
    const remoteDoc = remotePayload.doc || remotePayload;

    const { tryAutoMerge } = await import('./model.js');
    const merged = tryAutoMerge(State.doc, remoteDoc, State.lastSyncedDocJson);
    if (merged) {
        const session = await getActiveSession();
        if (!session) return;
        State.setDoc(merged);
        State.saveDocLocal();
        State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
        render();
        try {
            await pushToServer(session.user.id, row.version);
        } catch {
            setSyncStatus('error');
        }
        return;
    }

    State.setConflictRemoteDoc(remoteDoc);
    State.setConflictServerVersion(row.version);

    const localMd = exportMarkdown(State.doc.root).trim();
    const remoteMd = exportMarkdown(remoteDoc.root).trim();

    document.getElementById('conflict-local').value = localMd;
    document.getElementById('conflict-remote').value = remoteMd;
    document.getElementById('conflict-resolved').value = localMd;

    setSyncStatus('conflict');
    openModal('modal-conflict');
}

// ── Conflict modal resolution ─────────────────────────────────────────────────

export async function handleConflictUseLocal() {
    closeModal('modal-conflict');
    const session = await getActiveSession();
    if (session) {
        setSyncStatus('syncing');
        try {
            await pushToServer(session.user.id, State.conflictServerVersion);
        } catch {
            setSyncStatus('error');
        }
    } else {
        setSyncStatus('idle');
    }
}

export async function handleConflictUseRemote() {
    closeModal('modal-conflict');
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
    State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
    render();
    const session = await getActiveSession();
    if (session) {
        setSyncStatus('syncing');
        try {
            await pushToServer(session.user.id, State.conflictServerVersion);
        } catch {
            setSyncStatus('error');
        }
    } else {
        setSyncStatus('idle');
    }
}

// ── Sync loop ─────────────────────────────────────────────────────────────────

export async function syncNow() {
    const session = await getActiveSession();
    if (!session) return;

    setSyncStatus('syncing');
    try {
        const { data: row, error: fetchErr } = await supabaseClient
            .from(State.SYNC_TABLE)
            .select('version, data')
            .eq('user_id', session.user.id)
            .maybeSingle();

        if (fetchErr) throw fetchErr;

        const serverVersion = row ? row.version : 0;

        if (State.lastSyncedVersion === 0) {
            if (!row) {
                await pushToServer(session.user.id, 0);
            } else if (!State.doc.root.children.length) {
                await pullFromServer(row);
            } else {
                await handleConflict(row);
            }
        } else if (serverVersion > State.lastSyncedVersion) {
            if (State.pendingSync) {
                await handleConflict(row);
            } else {
                await pullFromServer(row);
            }
        } else {
            if (State.pendingSync) {
                await pushToServer(session.user.id, serverVersion);
            } else {
                setSyncStatus('synced');
            }
        }
    } catch (e) {
        console.error('Sync error:', e);
        setSyncStatus('error');
    }
}

export function startSync() {
    if (State.syncIntervalId) return;
    syncNow();
    State.setSyncIntervalId(setInterval(syncNow, State.SYNC_INTERVAL_MS));
}

export function stopSync() {
    if (State.syncIntervalId) {
        clearInterval(State.syncIntervalId);
        State.setSyncIntervalId(null);
    }
    setSyncStatus('idle');
}
