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
        State.setSyncPaused(false);
        return;
    }
    const remoteDoc = remotePayload.doc || remotePayload;

    const { tryAutoMerge } = await import('./model.js');
    const merged = tryAutoMerge(State.doc, remoteDoc, State.lastSyncedDocJson);
    if (merged) {
        State.setDoc(merged);
        State.saveDocLocal();
        State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
        render();
        // Record the server version we merged from so next loop doesn't re-pull
        State.setLastSyncedVersion(row.version);
        localStorage.setItem(State.SYNC_VERSION_KEY, String(row.version));
        // Mark pending so next sync loop will push the merged result
        State.setPendingSync(true);
        State.setSyncPaused(false);
        setSyncStatus('pending');
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
    // syncPaused remains true until user resolves the conflict
}

// ── Conflict modal resolution ─────────────────────────────────────────────────

export async function handleConflictUseLocal() {
    closeModal('modal-conflict');
    State.setSyncPaused(false);
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
    // Paused while waiting for user to resolve a conflict
    if (State.syncPaused) return;

    const session = await getActiveSession();
    if (!session) return;

    setSyncStatus('syncing');
    try {
        // Step 1: Get server version (lightweight — no data download yet).
        const { data: versionRow, error: versionErr } = await supabaseClient
            .from(State.SYNC_TABLE)
            .select('version')
            .eq('user_id', session.user.id)
            .maybeSingle();

        if (versionErr) throw versionErr;

        const serverVersion = versionRow ? versionRow.version : 0;

        // Step 2: Server version == local version.
        if (serverVersion === State.lastSyncedVersion) {
            // Send local data if there are pending changes, or if both sides are
            // at version 0 (client has never synced) and there is local content.
            const neverSynced = State.lastSyncedVersion === 0 && serverVersion === 0
                && State.doc.root.children.length > 0;
            if (State.pendingSync || neverSynced) {
                await pushToServer(session.user.id, serverVersion);
            } else {
                setSyncStatus('synced');
            }
            return;
        }

        // Step 2b: Server version is behind local — push pending changes.
        // This happens when the server row was removed since the last sync
        // (e.g. the row was deleted on another device).  Push to restore.
        if (serverVersion < State.lastSyncedVersion) {
            if (State.pendingSync) {
                await pushToServer(session.user.id, serverVersion);
            } else {
                setSyncStatus('synced');
            }
            return;
        }

        // Step 3: Server version is ahead of local version — pull server data.
        const { data: dataRow, error: fetchErr } = await supabaseClient
            .from(State.SYNC_TABLE)
            .select('data')
            .eq('user_id', session.user.id)
            .maybeSingle();

        if (fetchErr) throw fetchErr;

        const row = dataRow ? { ...dataRow, version: serverVersion } : null;

        if (!row) {
            // Server has no data row despite a non-zero version — unexpected data
            // integrity issue; log a warning and skip this tick.
            console.warn('Sync: server reported version', serverVersion, 'but returned no data row.');
            setSyncStatus('synced');
            return;
        }

        // Pause further sync ticks until server data has been applied.
        State.setSyncPaused(true);

        try {
            if (!State.pendingSync) {
                // No local changes — auto-apply server data and resume immediately.
                await pullFromServer(row);
                State.setSyncPaused(false);
            } else {
                // Local changes exist — try auto-merge or open conflict modal.
                // handleConflict unpauses on auto-merge; stays paused until user resolves.
                await handleConflict(row);
            }
            // Do not send local data until the next sync loop.
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
