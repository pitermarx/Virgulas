// ── Sync ──────────────────────────────────────────────────────────────────────
// Supabase authentication and cloud sync effects. This module performs async
// work and returns data to the caller; it does not mutate app state or the DOM.

import State from './state.js';
import { exportMarkdown } from './model.js';
import { deriveKey, generateSalt, bytesToB64, b64ToBytes, encrypt, decrypt } from './crypto.js';

const supabaseClient = window.supabase
    ? window.supabase.createClient(State.SUPABASE_URL, State.SUPABASE_KEY)
    : null;

const syncTable = () => supabaseClient.from(State.SYNC_TABLE);
const syncRow = (userId, select) => syncTable().select(select).eq('user_id', userId).maybeSingle();

function normalizeDoc(payload) {
    return payload?.doc || payload;
}

function hasAuthService() {
    return !!supabaseClient;
}

async function compressData(obj) {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(obj)));
            controller.close();
        }
    }).pipeThrough(new CompressionStream('gzip'));

    return bytesToB64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function decompressData(b64) {
    try {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(b64ToBytes(b64));
                controller.close();
            }
        }).pipeThrough(new DecompressionStream('gzip'));

        return JSON.parse(await new Response(stream).text());
    } catch {
        return JSON.parse(atob(b64));
    }
}

export async function encryptPayload(encryptionKey, obj) {
    const compressed = await compressData(obj);
    return encryptionKey ? encrypt(encryptionKey, compressed) : compressed;
}

async function decryptPayload(encryptionKey, data) {
    if (encryptionKey) {
        try {
            return decompressData(await decrypt(encryptionKey, data));
        } catch {
            return null;
        }
    }
    return decompressData(data);
}

async function ensureSaltOnServer(userId, saltB64) {
    if (!supabaseClient || !saltB64) return;
    try {
        await syncTable().upsert({ user_id: userId, salt: saltB64 }, { onConflict: 'user_id' });
    } catch (error) {
        console.warn('Failed to store salt:', error);
    }
}

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

async function pushDocToServer({ userId, doc, encryptionKey, baseServerVersion }) {
    const version = Math.max(doc.version || 1, baseServerVersion) + 1;
    const nextDoc = JSON.parse(JSON.stringify(doc));
    nextDoc.version = version;
    const saltB64 = localStorage.getItem(State.ENCRYPTION_SALT_KEY);

    const { error } = await syncTable().upsert({
        user_id: userId,
        data: await encryptPayload(encryptionKey, nextDoc),
        version,
        updated_at: new Date().toISOString(),
        ...(saltB64 ? { salt: saltB64 } : {}),
    }, { onConflict: 'user_id' });

    if (error) throw error;
    return { doc: nextDoc, version };
}

export function registerAuthListener(onSession) {
    if (!supabaseClient) return () => { };
    const subscription = supabaseClient.auth.onAuthStateChange((_event, session) => {
        onSession(session || null);
    });
    return () => subscription?.data?.subscription?.unsubscribe?.();
}

export async function getActiveSession() {
    if (!supabaseClient) return null;
    const { data } = await supabaseClient.auth.getSession();
    return data.session || null;
}

export async function initAuth() {
    if (!supabaseClient) return { kind: 'ready', user: null, encryptionKey: null };

    const { data } = await supabaseClient.auth.getSession();
    const user = data.session?.user || null;
    if (!user) return { kind: 'ready', user: null, encryptionKey: null };

    const password = localStorage.getItem(State.ENCRYPTION_PASSWORD_KEY);
    if (!password) {
        await supabaseClient.auth.signOut();
        localStorage.clear();
        return { kind: 'signed-out-missing-password' };
    }

    const salt = await resolveSalt(user.id);
    const encryptionKey = await deriveKey(password, salt.bytes);
    await ensureSaltOnServer(user.id, salt.b64);
    return { kind: 'ready', user, encryptionKey };
}

export async function submitLogin({ email, password, confirmPassword, mode }) {
    if (!email || !password) return { kind: 'error', message: 'Email and password are required.' };
    if (!hasAuthService()) return { kind: 'error', message: 'Authentication service unavailable.' };

    if (mode === 'signup') {
        if (password !== confirmPassword) return { kind: 'error', message: 'Passwords do not match.' };
        const { error } = await supabaseClient.auth.signUp({ email, password });
        return error
            ? { kind: 'error', message: error.message }
            : { kind: 'info', message: 'Check your email for a confirmation link.' };
    }

    const { data: signInData, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) return { kind: 'error', message: error.message };

    const user = signInData.user;
    const salt = await resolveSalt(user.id);
    const encryptionKey = await deriveKey(password, salt.bytes);
    localStorage.setItem(State.ENCRYPTION_PASSWORD_KEY, password);
    await ensureSaltOnServer(user.id, salt.b64);

    const { data: serverRow } = await syncRow(user.id, 'data, version');
    if (!serverRow?.data) {
        return {
            kind: 'signed-in',
            user,
            encryptionKey,
            serverDoc: null,
            serverVersion: 0,
        };
    }

    const decrypted = await decryptPayload(encryptionKey, serverRow.data);
    if (!decrypted) return { kind: 'error', message: 'Failed to decrypt synced data.' };

    return {
        kind: 'signed-in',
        user,
        encryptionKey,
        serverDoc: normalizeDoc(decrypted),
        serverVersion: serverRow.version,
    };
}

export async function performSignOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    localStorage.clear();
    return { kind: 'signed-out' };
}

export async function performDeleteAccount() {
    const session = await getActiveSession();
    if (session) await syncTable().delete().eq('user_id', session.user.id);
    return performSignOut();
}

export async function syncNow(snapshot) {
    if (snapshot.syncPaused || !snapshot.encryptionKey) return { kind: 'skip' };

    const session = await getActiveSession();
    if (!session) return { kind: 'skip' };

    const userId = session.user.id;

    try {
        const { data: versionRow, error: versionError } = await syncRow(userId, 'version');
        if (versionError) throw versionError;

        const serverVersion = versionRow?.version || 0;
        if (serverVersion <= snapshot.lastSyncedVersion) {
            const neverSynced = snapshot.lastSyncedVersion === 0 && serverVersion === 0
                && snapshot.doc.root.children.length > 0;

            if (!snapshot.pendingSync && !neverSynced) {
                return { kind: 'status', status: 'synced' };
            }

            const pushed = await pushDocToServer({
                userId,
                doc: snapshot.doc,
                encryptionKey: snapshot.encryptionKey,
                baseServerVersion: serverVersion,
            });

            return { kind: 'pushed', ...pushed };
        }

        const { data: dataRow, error: dataError } = await syncRow(userId, 'data');
        if (dataError) throw dataError;
        if (!dataRow?.data) return { kind: 'status', status: 'synced' };

        const remotePayload = await decryptPayload(snapshot.encryptionKey, dataRow.data);
        if (!remotePayload) return { kind: 'error' };
        const remoteDoc = normalizeDoc(remotePayload);

        if (!snapshot.pendingSync) {
            return { kind: 'pulled', doc: remoteDoc, version: serverVersion };
        }

        const { tryAutoMerge } = await import('./model.js');
        const merged = tryAutoMerge(snapshot.doc, remoteDoc, snapshot.lastSyncedDocJson);
        if (merged) {
            const pushed = await pushDocToServer({
                userId,
                doc: merged,
                encryptionKey: snapshot.encryptionKey,
                baseServerVersion: serverVersion,
            });

            return { kind: 'merged-pushed', doc: pushed.doc, version: pushed.version };
        }

        return {
            kind: 'conflict',
            local: exportMarkdown(snapshot.doc.root).trim(),
            remote: exportMarkdown(remoteDoc.root).trim(),
            serverVersion,
        };
    } catch (error) {
        console.error('Sync error:', error);
        return { kind: 'error' };
    }
}

export async function pushResolvedDoc(snapshot, baseServerVersion) {
    const session = await getActiveSession();
    if (!session || !snapshot.encryptionKey) return { kind: 'skip' };

    try {
        const pushed = await pushDocToServer({
            userId: session.user.id,
            doc: snapshot.doc,
            encryptionKey: snapshot.encryptionKey,
            baseServerVersion,
        });
        return { kind: 'pushed', ...pushed };
    } catch (error) {
        console.error('Conflict resolution push error:', error);
        return { kind: 'error' };
    }
}
