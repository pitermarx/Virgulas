// ── Crypto ────────────────────────────────────────────────────────────────────
// Client-side encryption (AES-GCM) + key derivation (PBKDF2).

// ── Binary ↔ base-64 (shared by state.js and sync.js) ────────────────────────

const CHUNK = 8192;

export function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK)
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(bin);
}

export function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// ── Key derivation ────────────────────────────────────────────────────────────

export function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(32));
}

const PBKDF2 = { name: 'PBKDF2', iterations: 600000, hash: 'SHA-256' };

async function importPassphrase(passphrase) {
    return crypto.subtle.importKey(
        'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
}

export async function deriveKey(passphrase, salt) {
    return crypto.subtle.deriveKey(
        { ...PBKDF2, salt }, await importPassphrase(passphrase),
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

export async function deriveAuthToken(passphrase, salt) {
    const hmacKey = await crypto.subtle.deriveKey(
        { ...PBKDF2, salt }, await importPassphrase(passphrase),
        { name: 'HMAC', hash: 'SHA-256', length: 256 }, true, ['sign']
    );
    return bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', hmacKey)));
}

// ── Encryption / decryption ───────────────────────────────────────────────────

export async function encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
    );
    const combined = new Uint8Array(12 + ct.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ct), 12);
    return bytesToB64(combined);
}

export async function decrypt(key, b64) {
    const combined = b64ToBytes(b64);
    if (combined.length <= 12) throw new Error('Ciphertext too short');
    return new TextDecoder().decode(
        await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: combined.slice(0, 12) }, key, combined.slice(12)
        )
    );
}
