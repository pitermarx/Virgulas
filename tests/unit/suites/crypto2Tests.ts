import {
    randomId,
    generateSalt,
    encrypt,
    decrypt,
    getEnvelopeIterations,
    needsKdfUpgrade,
    DEFAULT_ITERATIONS,
    LEGACY_ITERATIONS,
    MIN_PASSPHRASE_LENGTH
} from '../../../source/js/crypto2.js'
import {
    assert,
    assertEqual,
    assertNotEqual,
    cloneSections,
    createAsyncSectionHarness
} from '../testing.js'

export const crypto2Total = 18

let _cachedResult: any = null

export async function runCrypto2Tests(onProgress: any) {
    if (_cachedResult) {
        if (onProgress) onProgress(_cachedResult)
        return _cachedResult
    }

    const h = createAsyncSectionHarness({ onProgress })
    const { section, test } = h

    section('Identifiers and salt')

    await test('randomId values are unique across multiple calls', async () => {
        const ids = new Set()
        for (let i = 0; i < 24; i++) ids.add(randomId())
        assertEqual(ids.size, 24, 'randomId should not collide in a small sample')
    })

    await test('generateSalt returns base64 that decodes to 16 bytes', async () => {
        const salt = generateSalt()
        assert(typeof salt === 'string', 'generateSalt should return a string')
        const decoded = Uint8Array.from(atob(salt), c => c.charCodeAt(0))
        assertEqual(decoded.length, 16, 'Salt should decode to 16 bytes')
    })

    await test('generateSalt values are unique across multiple calls', async () => {
        const salts = new Set()
        for (let i = 0; i < 24; i++) salts.add(generateSalt())
        assertEqual(salts.size, 24, 'generateSalt should not collide in a small sample')
    })

    section('Encryption and decryption')

    await test('Round-trip for plain ASCII text', async () => {
        const text = 'Virgulas test payload 12345'
        const passphrase = 'correct horse battery staple'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)
        const decrypted = await decrypt(encrypted, passphrase, salt)
        assertEqual(decrypted, text, 'Decrypted payload should match original')
    })

    await test('Round-trip preserves multiline symbol text', async () => {
        const text = 'line 1\nline 2\nSymbols: [] {} <> ! ? / \\ = + * _'
        const passphrase = 'senha-super-segura'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)
        const decrypted = await decrypt(encrypted, passphrase, salt)
        assertEqual(decrypted, text, 'Unicode payload should remain identical')
    })

    await test('Round-trip supports empty string payload', async () => {
        const text = ''
        const passphrase = 'empty-case'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)
        const decrypted = await decrypt(encrypted, passphrase, salt)
        assertEqual(decrypted, text, 'Empty payload should round-trip')
    })

    await test('Large payload round-trip', async () => {
        const text = ('0123456789abcdef'.repeat(8192)) + '\nend'
        const passphrase = 'large-payload-key'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)
        const decrypted = await decrypt(encrypted, passphrase, salt)
        assertEqual(decrypted, text, 'Large payload should round-trip')
    })

    await test('Same input encrypted twice yields different ciphertext', async () => {
        const text = 'same-message'
        const passphrase = 'same-pass'
        const salt = generateSalt()
        const encryptedA = await encrypt(text, passphrase, salt)
        const encryptedB = await encrypt(text, passphrase, salt)
        assertNotEqual(encryptedA, encryptedB, 'Ciphertexts should differ due to random IV')
    })

    await test('Ciphertext carries IV + payload bytes inside a v2 envelope', async () => {
        const text = 'small message'
        const passphrase = 'shape-check'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)
        assert(typeof encrypted === 'string' && encrypted.length > 0, 'Encrypted output should be a non-empty string')

        const parts = encrypted.split(':')
        assertEqual(parts[0], 'v2', 'Envelope version prefix')
        const bytes = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0))
        assert(bytes.length > 12, 'Encrypted bytes should contain 12-byte IV plus ciphertext')
    })

    section('KDF envelope parameters')

    await test('New payloads record the current iteration count', async () => {
        const encrypted = await encrypt('hello', 'envelope-pass-123', generateSalt())
        assert(encrypted.startsWith(`v2:${DEFAULT_ITERATIONS}:`), `unexpected envelope prefix: ${encrypted.slice(0, 24)}`)
        assertEqual(getEnvelopeIterations(encrypted), DEFAULT_ITERATIONS, 'recorded iterations')
        assert(!needsKdfUpgrade(encrypted), 'fresh payload needs no upgrade')
    })

    await test('Legacy raw-base64 payloads still decrypt and report legacy iterations', async () => {
        const text = 'legacy payload'
        const passphrase = 'legacy-pass-123'
        const salt = generateSalt()
        // Build a legacy payload: encrypt at legacy iterations, then strip the header.
        const versioned = await encrypt(text, passphrase, salt, LEGACY_ITERATIONS)
        const legacy = versioned.split(':').slice(2).join(':')

        assert(!legacy.startsWith('v2:'), 'legacy payload has no version header')
        assertEqual(getEnvelopeIterations(legacy), LEGACY_ITERATIONS, 'legacy iterations')
        assert(needsKdfUpgrade(legacy), 'legacy payload needs upgrade')
        assertEqual(await decrypt(legacy, passphrase, salt), text, 'legacy payload decrypts')
    })

    await test('Versioned payloads written with legacy iterations still decrypt', async () => {
        const text = 'old v2 payload'
        const passphrase = 'v2-old-pass-123'
        const salt = generateSalt()
        const old = await encrypt(text, passphrase, salt, LEGACY_ITERATIONS)

        assert(old.startsWith(`v2:${LEGACY_ITERATIONS}:`), 'records the legacy iteration count')
        assert(needsKdfUpgrade(old), 'reports upgrade needed')
        assertEqual(await decrypt(old, passphrase, salt), text, 'decrypts at the recorded iterations')
    })

    await test('Malformed envelopes fail with the normalized error', async () => {
        const salt = generateSalt()
        let threw = false
        try {
            await decrypt('v2:not-a-number:abc', 'pass-1234567', salt)
        } catch (e) {
            threw = true
            assertEqual((e as Error).message, 'Invalid password or corrupted data', 'normalized error')
        }
        assert(threw, 'malformed envelope should be rejected')
    })

    await test('Payloads larger than the base64 chunk size round-trip', async () => {
        const bytes = window.crypto.getRandomValues(new Uint8Array(200_000))
        const text = Array.from(bytes, b => String.fromCharCode(33 + (b % 90))).join('')
        const passphrase = 'large-payload-pass'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)

        assert(encrypted.length > 200_000, 'envelope exceeds the old spread-argument limit')
        assertEqual(await decrypt(encrypted, passphrase, salt), text, 'large payload round-trips')
    })

    await test('minimum passphrase length is enforced for new passphrases', () => {
        assertEqual(MIN_PASSPHRASE_LENGTH, 10, 'documented minimum')
    })

    section('Failure behavior')

    await test('Decrypt fails with wrong passphrase', async () => {
        const text = 'top secret'
        const salt = generateSalt()
        const encrypted = await encrypt(text, 'correct-pass', salt)

        let threw = false
        try {
            await decrypt(encrypted, 'wrong-pass', salt)
        } catch (e) {
            threw = true
            assertEqual((e as Error).message, 'Invalid password or corrupted data', 'Wrong passphrase should return normalized error')
        }

        assert(threw, 'Decrypt should fail with wrong passphrase')
    })

    await test('Decrypt fails with wrong salt', async () => {
        const text = 'salt mismatch test'
        const encrypted = await encrypt(text, 'same-pass', generateSalt())

        let threw = false
        try {
            await decrypt(encrypted, 'same-pass', generateSalt())
        } catch (e) {
            threw = true
            assertEqual((e as Error).message, 'Invalid password or corrupted data', 'Wrong salt should return normalized error')
        }

        assert(threw, 'Decrypt should fail with wrong salt')
    })

    await test('Decrypt fails when ciphertext is tampered', async () => {
        const text = 'integrity check'
        const passphrase = 'tamper-check-pass'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)

        const parts = encrypted.split(':')
        const bytes = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0))
        bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0x01
        const tampered = `${parts[0]}:${parts[1]}:${btoa(String.fromCharCode(...bytes))}`

        let threw = false
        try {
            await decrypt(tampered, passphrase, salt)
        } catch (e) {
            threw = true
            assertEqual((e as Error).message, 'Invalid password or corrupted data', 'Tampered payload should return normalized error')
        }

        assert(threw, 'Decrypt should fail when ciphertext integrity is broken')
    })

    _cachedResult = { sections: cloneSections(h.sections), summary: h.summary() }
    return _cachedResult
}
