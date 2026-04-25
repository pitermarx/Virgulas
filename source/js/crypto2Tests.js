import {
    randomId,
    generateSalt,
    encrypt,
    decrypt,
    encryptSecretWithKeyBytes,
    decryptSecretWithKeyBytes
} from './crypto2.js'
import {
    assert,
    assertEqual,
    assertNotEqual,
    cloneSections,
    createAsyncSectionHarness
} from './testing.js'

export const crypto2Total = 15

let _cachedResult = null

export async function runCrypto2Tests(onProgress) {
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

    await test('Ciphertext is base64 and includes IV + payload bytes', async () => {
        const text = 'small message'
        const passphrase = 'shape-check'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)
        assert(typeof encrypted === 'string' && encrypted.length > 0, 'Encrypted output should be a non-empty string')

        const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0))
        assert(bytes.length > 12, 'Encrypted bytes should contain 12-byte IV plus ciphertext')
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
            assertEqual(e.message, 'Invalid password or corrupted data', 'Wrong passphrase should return normalized error')
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
            assertEqual(e.message, 'Invalid password or corrupted data', 'Wrong salt should return normalized error')
        }

        assert(threw, 'Decrypt should fail with wrong salt')
    })

    await test('Decrypt fails when ciphertext is tampered', async () => {
        const text = 'integrity check'
        const passphrase = 'tamper-check-pass'
        const salt = generateSalt()
        const encrypted = await encrypt(text, passphrase, salt)

        const bytes = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0))
        bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0x01
        const tampered = btoa(String.fromCharCode(...bytes))

        let threw = false
        try {
            await decrypt(tampered, passphrase, salt)
        } catch (e) {
            threw = true
            assertEqual(e.message, 'Invalid password or corrupted data', 'Tampered payload should return normalized error')
        }

        assert(threw, 'Decrypt should fail when ciphertext integrity is broken')
    })

    section('Wrapped secret helpers')

    await test('Wrapped secret round-trip with raw key bytes', async () => {
        const keyBytes = window.crypto.getRandomValues(new Uint8Array(32))
        const secret = 'device-local-passphrase'
        const wrapped = await encryptSecretWithKeyBytes(secret, keyBytes)
        const unwrapped = await decryptSecretWithKeyBytes(wrapped, keyBytes)
        assertEqual(unwrapped, secret, 'Wrapped secret should decrypt to original value')
    })

    await test('Wrapped secret decrypt fails with wrong key bytes', async () => {
        const keyBytesA = window.crypto.getRandomValues(new Uint8Array(32))
        const keyBytesB = window.crypto.getRandomValues(new Uint8Array(32))
        const wrapped = await encryptSecretWithKeyBytes('secret-A', keyBytesA)

        let threw = false
        try {
            await decryptSecretWithKeyBytes(wrapped, keyBytesB)
        } catch (e) {
            threw = true
            assertEqual(e.message, 'Failed to decrypt wrapped secret', 'Wrong key bytes should return normalized error')
        }

        assert(threw, 'Decrypt should fail with different key bytes')
    })

    _cachedResult = { sections: cloneSections(h.sections), summary: h.summary() }
    return _cachedResult
}
