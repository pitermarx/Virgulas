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

/**
 * PBKDF2 work divisor for the Playwright build. Dividing the work keeps E2E
 * setup and unlock from dominating the suite while the stored envelope still
 * records the nominal iteration count, so the key format and the KDF-upgrade
 * behaviour are unchanged.
 *
 * The scale is a build-time constant for every derivation the app performs; it is
 * never read from a mutable global or any other runtime source a same-origin
 * script could set. The runner-side seeding helper passes the value explicitly to
 * `encrypt`, which cannot influence how the app derives keys on unlock or save.
 */
export const TEST_KDF_SCALE = 60

// Production defines __TEST_KDF_SCALE__ as 1 and this folds away. Unit tests run
// the source directly, where the constant is undefined.
function kdfScale(): number {
    return typeof __TEST_KDF_SCALE__ === 'number' && __TEST_KDF_SCALE__ > 1 ? __TEST_KDF_SCALE__ : 1
}

const ENVELOPE_PREFIX = 'v2'

export class WrongPassphraseError extends Error {
    constructor() {
        super('Invalid passphrase.')
        this.name = 'WrongPassphraseError'
    }
}

export class CorruptEnvelopeError extends Error {
    constructor(message = 'Encrypted data is corrupted or incomplete.') {
        super(message)
        this.name = 'CorruptEnvelopeError'
    }
}

export class UnsupportedVersionError extends Error {
    constructor(message = 'This document uses an unsupported version. Reload the app to get the latest version.') {
        super(message)
        this.name = 'UnsupportedVersionError'
    }
}

export class UnsupportedBrowserError extends Error {
    constructor() {
        super('This browser cannot decrypt the document. Update your browser and reload.')
        this.name = 'UnsupportedBrowserError'
    }
}

async function compress(string: string): Promise<ArrayBuffer> {
    const compressionStream = new CompressionStream('gzip')
    const writer = compressionStream.writable.getWriter()
    writer.write(new TextEncoder().encode(string))
    writer.close()
    return await new Response(compressionStream.readable).arrayBuffer()
}

async function decompress(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    let decompressionStream: DecompressionStream
    try {
        decompressionStream = new DecompressionStream('gzip')
    } catch {
        throw new UnsupportedBrowserError()
    }

    try {
        const writer = decompressionStream.writable.getWriter()
        const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        const decompressedPromise = new Response(decompressionStream.readable).arrayBuffer()
        await writer.write(input as unknown as BufferSource)
        await writer.close()
        const decompressed = await decompressedPromise
        return new TextDecoder().decode(decompressed)
    } catch {
        throw new CorruptEnvelopeError('The decrypted data is not a valid compressed document.')
    }
}

async function deriveKey(passphrase: string, saltBase64: string, iterations: number, scale: number): Promise<CryptoKey> {
    const enc = new TextEncoder()
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    )

    const salt = fromBase64(saltBase64)

    // Derive at the scaled work factor while callers keep using the nominal
    // iteration count for the envelope and the derived-key cache.
    const workIterations = scale > 1 ? Math.max(1, Math.round(iterations / scale)) : iterations

    return await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as unknown as BufferSource,
            iterations: workIterations,
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
let cachedKey: { passphrase: string; salt: string; iterations: number; scale: number; key: CryptoKey } | null = null

async function getDerivedKey(passphrase: string, salt: string, iterations: number, scale: number): Promise<CryptoKey> {
    const cached = cachedKey
    if (cached && cached.passphrase === passphrase && cached.salt === salt && cached.iterations === iterations && cached.scale === scale) {
        return cached.key
    }
    const key = await deriveKey(passphrase, salt, iterations, scale)
    cachedKey = { passphrase, salt, iterations, scale, key }
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

function parsePayload(payload: string): Uint8Array {
    try {
        const combined = fromBase64(payload)
        if (combined.length < 28) throw new CorruptEnvelopeError()
        return combined
    } catch (error) {
        if (error instanceof CorruptEnvelopeError) throw error
        throw new CorruptEnvelopeError()
    }
}

function parseEnvelope(envelope: string): ParsedEnvelope {
    const value = String(envelope ?? '')
    const version = /^v(\d+):/.exec(value)
    if (version) {
        if (version[1] !== ENVELOPE_PREFIX.slice(1)) {
            throw new UnsupportedVersionError(`Encrypted data uses unsupported envelope version ${version[1]}. Reload the app to get the latest version.`)
        }
        const [prefix, iterationsRaw, payload, ...extra] = value.split(':')
        const iterations = Number(iterationsRaw)
        if (prefix !== ENVELOPE_PREFIX || extra.length > 0 || !Number.isInteger(iterations) || iterations <= 0 || !payload) {
            throw new CorruptEnvelopeError()
        }
        return { iterations, combined: parsePayload(payload) }
    }
    // Legacy payload: raw base64 written before KDF params were recorded.
    return { iterations: LEGACY_ITERATIONS, combined: parsePayload(value) }
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
async function encrypt(text: string, passphrase: string, salt: string, iterations: number = DEFAULT_ITERATIONS, scale: number = kdfScale()): Promise<string> {
    const encodedText = await compress(text)

    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const key = await getDerivedKey(passphrase, salt, iterations, scale)
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
    const subtle = typeof window === 'undefined' ? undefined : window.crypto?.subtle
    if (!subtle
        || typeof subtle.importKey !== 'function'
        || typeof subtle.deriveKey !== 'function'
        || typeof subtle.decrypt !== 'function'
        || typeof CompressionStream !== 'function'
        || typeof DecompressionStream !== 'function') {
        throw new UnsupportedBrowserError()
    }

    const { iterations, combined } = parseEnvelope(envelope)
    try {
        if (fromBase64(String(salt ?? '')).length !== 16) throw new CorruptEnvelopeError('Encrypted data has an invalid salt.')
    } catch (error) {
        if (error instanceof CorruptEnvelopeError) throw error
        throw new CorruptEnvelopeError('Encrypted data has an invalid salt.')
    }

    // Extract IV (first 12 bytes) and Ciphertext. parsePayload validates that
    // the ciphertext also contains the minimum AES-GCM authentication tag.
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    let key: CryptoKey
    try {
        key = await getDerivedKey(passphrase, salt, iterations, kdfScale())
    } catch (error) {
        if ((error as { name?: string } | null)?.name === 'NotSupportedError') {
            throw new UnsupportedBrowserError()
        }
        throw error
    }

    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            ciphertext
        )
        return await decompress(decrypted)
    } catch (error) {
        if (error instanceof CorruptEnvelopeError || error instanceof UnsupportedBrowserError) throw error
        if ((error as { name?: string } | null)?.name === 'NotSupportedError') {
            throw new UnsupportedBrowserError()
        }
        throw new WrongPassphraseError()
    }
}

export {
    randomId,
    generateSalt,
    encrypt,
    decrypt
}
