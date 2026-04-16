const debug = new URLSearchParams(window.location.search).get('debug')
const log = debug === 'true' ? console.log.bind(console, '[debug crypto]') : () => { }

async function compress(string) {
    const compressionStream = new CompressionStream('gzip')
    const writer = compressionStream.writable.getWriter()
    writer.write(new TextEncoder().encode(string))
    writer.close()
    return await new Response(compressionStream.readable).arrayBuffer()
}

async function decompress(bytes) {
    const decompressionStream = new DecompressionStream('gzip')
    const writer = decompressionStream.writable.getWriter()
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    writer.write(input)
    writer.close()
    const decompressed = await new Response(decompressionStream.readable).arrayBuffer()
    return new TextDecoder().decode(decompressed)
}

// Derives an AES-GCM key from a passphrase and salt using PBKDF2
// 310,000 iterations, SHA-256, 256-bit output
async function deriveKey(passphrase, saltBase64) {
    const enc = new TextEncoder()
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    )

    // Convert salt from base64 back to Uint8Array
    const salt = fromBase64(saltBase64)

    return await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 310000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, // Key is not extractable
        ["encrypt", "decrypt"]
    )
}

function randomId() {
    return Math.random().toString(36).substring(2, 10)
}

function generateSalt() {
    return toBase64(window.crypto.getRandomValues(new Uint8Array(16)))
}

function toBase64(bytes) {
    if (bytes.length > 65536) {
        log('Warning: toBase64 may fail for large byte arrays due to argument length limits. TODO: implement a chunked version if this becomes an issue.')
    }
    return btoa(String.fromCharCode(...bytes))
}
function fromBase64(base64) {
    if (base64.length > 65536) {
        log('Warning: fromBase64 may fail for large strings due to argument length limits. TODO: implement a chunked version if this becomes an issue.')
    }
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}

// Encrypts text with AES-GCM-256
// Returns base64 encoded string: IV (12 bytes) + Ciphertext
async function encrypt(text, passphrase, salt) {
    const encodedText = await compress(text)

    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const key = await deriveKey(passphrase, salt)
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encodedText
    )

    // Concatenate IV and Ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(ciphertext), iv.length)

    // Convert to base64
    return toBase64(combined)
}

// Decrypts base64 encoded string with AES-GCM-256
// Returns decrypted text
async function decrypt(encryptedBase64, passphrase, salt) {
    // Convert from base64 to Uint8Array
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0))

    // Extract IV (first 12 bytes) and Ciphertext
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    try {
        const key = await deriveKey(passphrase, salt)
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            ciphertext
        )

        return await decompress(decrypted)
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
