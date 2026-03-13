// ── Crypto ────────────────────────────────────────────────────────────────────
// Client-side encryption utilities using the Web Crypto API.
// All data is encrypted with AES-GCM; keys are derived from a user passphrase
// using PBKDF2 (600 000 iterations, SHA-256).  The CryptoKey is never persisted
// — only the random salt and a small verification ciphertext go to localStorage.

// ── Key derivation ────────────────────────────────────────────────────────────

export function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(32));
}

async function _importPassphrase(passphrase) {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey']
    );
}

export async function deriveKey(passphrase, salt) {
    const keyMaterial = await _importPassphrase(passphrase);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Derives an authentication token from the passphrase and salt using HMAC-SHA-256.
// Using a different key type (HMAC vs AES-GCM) ensures the auth token and
// encryption key are cryptographically independent even when the same password
// and salt are used.
export async function deriveAuthToken(passphrase, salt) {
    const keyMaterial = await _importPassphrase(passphrase);
    const hmacKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        true,
        ['sign']
    );
    const raw = await crypto.subtle.exportKey('raw', hmacKey);
    let bin = '';
    const bytes = new Uint8Array(raw);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// ── Encryption / decryption ───────────────────────────────────────────────────
// The returned base-64 string has the 12-byte IV prepended before the ciphertext
// so that decrypt() is self-contained.

export async function encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), 12);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < combined.length; i += CHUNK) {
        binary += String.fromCharCode(...combined.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export async function decrypt(key, b64) {
    const binary = atob(b64);
    const combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);
    if (combined.length <= 12) throw new Error('Ciphertext too short');
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
}
