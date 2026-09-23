import { biometrics } from '../../../source/js/biometrics.js'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

// ─── Minimal in-memory IndexedDB (happy-dom does not provide one) ─────────────

class FakeRequest<T> {
    onsuccess: (() => void) | null = null
    onerror: (() => void) | null = null
    onupgradeneeded: (() => void) | null = null
    error: unknown = null
    constructor(public result: T) { }
}

class FakeObjectStore {
    data = new Map<string, unknown>()
    get(key: string) {
        const req = new FakeRequest<unknown>(this.data.get(key))
        queueMicrotask(() => req.onsuccess?.())
        return req
    }
    put(value: unknown, key: string) {
        this.data.set(key, value)
        return new FakeRequest<undefined>(undefined)
    }
    delete(key: string) {
        this.data.delete(key)
        return new FakeRequest<undefined>(undefined)
    }
}

class FakeTransaction {
    oncomplete: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(private db: FakeDB) {
        queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()))
    }
    objectStore(_name: string) { return this.db.store }
}

class FakeDB {
    store = new FakeObjectStore()
    createObjectStore(_name: string) { return this.store }
    transaction(_name: string, _mode: string) { return new FakeTransaction(this) }
}

function installFakeIndexedDB() {
    const databases = new Map<string, FakeDB>()
    ;(globalThis as any).indexedDB = {
        open(name: string) {
            let db = databases.get(name)
            if (!db) {
                db = new FakeDB()
                databases.set(name, db)
            }
            const req = new FakeRequest(db)
            queueMicrotask(() => {
                req.onupgradeneeded?.()
                req.onsuccess?.()
            })
            return req
        }
    }
}

// ─── WebAuthn / crypto stubs ─────────────────────────────────────────────────

function ensureWindowCrypto() {
    if (!(window as any).crypto?.subtle) {
        Object.defineProperty(window, 'crypto', { configurable: true, value: globalThis.crypto })
    }
}

function enableWebAuthn() {
    ensureWindowCrypto()
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class { } })
    const rawId = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer
    Object.defineProperty(navigator, 'credentials', {
        configurable: true,
        value: {
            create: async () => ({ rawId, id: 'credential-1' }),
            get: async () => ({ rawId, id: 'credential-1' })
        }
    })
}

function disableWebAuthn() {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {} })
}

section('biometrics support detection')

await test('isSupported follows WebAuthn availability', () => {
    disableWebAuthn()
    assertEqual(biometrics.isSupported(), false, 'unsupported without PublicKeyCredential')
    enableWebAuthn()
    assertEqual(biometrics.isSupported(), true, 'supported with create/get helpers')
})

await test('enroll rejects when WebAuthn is unsupported', async () => {
    disableWebAuthn()
    let message = ''
    try {
        await biometrics.enroll('secret')
    } catch (error) {
        message = (error as Error).message
    }
    assertEqual(message, 'Biometric unlock is not supported in this browser.', 'unsupported message')
})

await test('unlock returns null when WebAuthn is unsupported', async () => {
    disableWebAuthn()
    assertEqual(await biometrics.unlock(), null, 'null result')
})

section('biometric enroll / unlock')

await test('rejects an empty passphrase', async () => {
    enableWebAuthn()
    let message = ''
    try {
        await biometrics.enroll('')
    } catch (error) {
        message = (error as Error).message
    }
    assertEqual(message, 'A passphrase is required to enable biometric unlock.', 'empty passphrase message')
})

await test('enroll stores a wrapped passphrase that unlock recovers', async () => {
    installFakeIndexedDB()
    enableWebAuthn()
    await biometrics.forget().catch(() => { })

    assertEqual(await biometrics.hasEnrolled(), false, 'starts unenrolled')
    await biometrics.enroll('correct-horse-battery', 'Tester')
    assertEqual(await biometrics.hasEnrolled(), true, 'enrolled')
    assertEqual(await biometrics.unlock(), 'correct-horse-battery', 'passphrase recovered')
})

await test('forget removes the stored credential and wrapped passphrase', async () => {
    installFakeIndexedDB()
    enableWebAuthn()
    await biometrics.enroll('to-be-forgotten', 'Tester')
    assertEqual(await biometrics.hasEnrolled(), true, 'enrolled first')

    await biometrics.forget()
    assertEqual(await biometrics.hasEnrolled(), false, 'credential removed')
    assertEqual(await biometrics.unlock(), null, 'unlock returns null after forget')
})

await test('unlock returns null when no credential is stored', async () => {
    installFakeIndexedDB()
    enableWebAuthn()
    await biometrics.forget().catch(() => { })
    assertEqual(await biometrics.unlock(), null, 'nothing to unlock')
})

await test('hasEnrolled is false when IndexedDB is unavailable', async () => {
    ;(globalThis as any).indexedDB = undefined
    assertEqual(await biometrics.hasEnrolled(), false, 'graceful on missing IndexedDB')
    installFakeIndexedDB()
})
