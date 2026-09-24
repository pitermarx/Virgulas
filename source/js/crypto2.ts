// ── KDF parameters and envelope format ───────────────────────────────────────
//
// The derived key comes from PBKDF2-HMAC-SHA256 (AES-GCM-256, non-extractable).
// The iteration count is not a compile-time constant any more: it is recorded in
// the stored envelope so it can be raised without breaking existing documents.
//
//   v2:<iterations>:<base64(iv || ciphertext)>
//
// Payloads without the `v2:` prefix are legacy (raw base64, LEGACY_ITERATIONS).
// `needsKdfUpgrade` reports when a stored envelope is below the current target;
// the normal debounced save then re-encrypts it transparently.
export const LEGACY_ITERATIONS = 310000
export const DEFAULT_ITERATIONS = 600000
/** Minimum length for a *new* encryption passphrase (existing ones still unlock). */
export const MIN_PASSPHRASE_LENGTH = 10

const ENVELOPE_PREFIX = 'v2'

async function compress(string: string): Promise<ArrayBuffer> {
    const compressionStream = new CompressionStream('gzip')
    const writer = compressionStream.writable.getWriter()
    writer.write(new TextEncoder().encode(string))
    writer.close()
    return await new Response(compressionStream.readable).arrayBuffer()
}

async function decompress(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const decompressionStream = new DecompressionStream('gzip')
    const writer = decompressionStream.writable.getWriter()
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    writer.write(input as unknown as BufferSource)
    writer.close()
    const decompressed = await new Response(decompressionStream.readable).arrayBuffer()
    return new TextDecoder().decode(decompressed)
}

async function deriveKey(passphrase: string, saltBase64: string, iterations: number): Promise<CryptoKey> {
    const enc = new TextEncoder()
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    )

    const salt = fromBase64(saltBase64)

    return await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as unknown as BufferSource,
            iterations,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, // Key is not extractable
        ["encrypt", "decrypt"]
    )
}

// Deriving a 600k-iteration key is deliberately slow, and autosave encrypts on
// every pause. Cache the last derived key for the unlocked session so the cost is
// paid once per (passphrase, salt, iterations) instead of on every write.
let cachedKey: { passphrase: string; salt: string; iterations: number; key: CryptoKey } | null = null

async function getDerivedKey(passphrase: string, salt: string, iterations: number): Promise<CryptoKey> {
    const cached = cachedKey
    if (cached && cached.passphrase === passphrase && cached.salt === salt && cached.iterations === iterations) {
        return cached.key
    }
    const key = await deriveKey(passphrase, salt, iterations)
    cachedKey = { passphrase, salt, iterations, key }
    return key
}

function randomId(): string {
    return Math.random().toString(36).substring(2, 10)
}

function generateSalt(): string {
    return toBase64(window.crypto.getRandomValues(new Uint8Array(16)))
}

// Chunked so a large document does not overflow the argument limit of
// `String.fromCharCode(...bytes)` (which throws RangeError past ~64k bytes).
const BASE64_CHUNK_SIZE = 0x8000

function toBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE))
    }
    return btoa(binary)
}

function fromBase64(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

interface ParsedEnvelope {
    iterations: number
    combined: Uint8Array
}

function encodeEnvelope(combined: Uint8Array, iterations: number): string {
    return `${ENVELOPE_PREFIX}:${iterations}:${toBase64(combined)}`
}

function parseEnvelope(envelope: string): ParsedEnvelope {
    const value = String(envelope ?? '')
    if (value.startsWith(`${ENVELOPE_PREFIX}:`)) {
        const [prefix, iterationsRaw, payload] = value.split(':')
        const iterations = Number(iterationsRaw)
        if (prefix !== ENVELOPE_PREFIX || !Number.isInteger(iterations) || iterations <= 0 || !payload) {
            throw new Error('Invalid encrypted envelope')
        }
        return { iterations, combined: fromBase64(payload) }
    }
    // Legacy payload: raw base64 written before KDF params were recorded.
    return { iterations: LEGACY_ITERATIONS, combined: fromBase64(value) }
}

/** Iteration count recorded in a stored envelope (legacy payloads report LEGACY_ITERATIONS). */
export function getEnvelopeIterations(envelope: string): number {
    try {
        return parseEnvelope(envelope).iterations
    } catch {
        return LEGACY_ITERATIONS
    }
}

/** True when a stored envelope was written with fewer iterations than the current target. */
export function needsKdfUpgrade(envelope: string): boolean {
    return getEnvelopeIterations(envelope) < DEFAULT_ITERATIONS
}

// Encrypts text with AES-GCM-256.
// Returns a versioned envelope: v2:<iterations>:<base64(iv || ciphertext)>
async function encrypt(text: string, passphrase: string, salt: string, iterations: number = DEFAULT_ITERATIONS): Promise<string> {
    const encodedText = await compress(text)

    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const key = await getDerivedKey(passphrase, salt, iterations)
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encodedText
    )

    // Concatenate IV and Ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(ciphertext), iv.length)

    const result = encodeEnvelope(combined, iterations)
    return result
}

// Decrypts a stored envelope (v2 or legacy) with AES-GCM-256. Returns decrypted text.
async function decrypt(envelope: string, passphrase: string, salt: string): Promise<string> {
    try {
        const { iterations, combined } = parseEnvelope(envelope)

        // Extract IV (first 12 bytes) and Ciphertext
        const iv = combined.slice(0, 12)
        const ciphertext = combined.slice(12)

        const key = await getDerivedKey(passphrase, salt, iterations)
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            ciphertext
        )

        const result = await decompress(decrypted)
        return result
    } catch (e) {
        console.error("Decryption failed:", e)
        throw new Error("Invalid password or corrupted data")
    }
}

export {
    randomId,
    generateSalt,
    encrypt,
    decrypt
}
