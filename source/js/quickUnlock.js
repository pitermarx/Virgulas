import { decryptSecretWithKeyBytes, encryptSecretWithKeyBytes } from './crypto2.js'
import { store } from './utils.js'

const VERSION = 1

function createState() {
    return {
        version: VERSION,
        local: null,
        remote: {}
    }
}

function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') return createState()

    const local = raw.local && typeof raw.local === 'object' ? raw.local : null
    const remote = raw.remote && typeof raw.remote === 'object' ? raw.remote : {}

    return {
        version: VERSION,
        local,
        remote
    }
}

function readState() {
    const raw = store.quickUnlock.get('')
    if (!raw) return createState()

    try {
        return normalizeState(JSON.parse(raw))
    } catch {
        return createState()
    }
}

function writeState(state) {
    store.quickUnlock.set(JSON.stringify(normalizeState(state)))
}

function normalizeAccountId(accountId) {
    return String(accountId || '').trim().toLowerCase()
}

function normalizeMode(mode) {
    return mode === 'local' || mode === 'remote' ? mode : null
}

function toBase64Url(bytes) {
    const base64 = btoa(String.fromCharCode(...bytes))
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(base64url) {
    const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0))
}

function randomBytes(length) {
    return window.crypto.getRandomValues(new Uint8Array(length))
}

function asUint8Array(value) {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value)
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    }
    throw quickUnlockError('Authenticator returned invalid PRF output.', 'prf-unavailable')
}

function quickUnlockError(message, code, cause = null) {
    const error = new Error(message)
    error.code = code
    if (cause) error.cause = cause
    return error
}

function mapWebAuthnError(error, fallbackCode = 'unknown') {
    const name = String(error?.name || '')
    if (name === 'NotAllowedError' || name === 'AbortError') {
        return quickUnlockError('Quick unlock action was cancelled.', 'cancelled', error)
    }
    if (name === 'InvalidStateError') {
        return quickUnlockError('Saved quick unlock credential is no longer available on this device.', 'credential-missing', error)
    }
    if (name === 'NotSupportedError') {
        return quickUnlockError('Quick unlock is not supported by this browser or authenticator.', 'unsupported', error)
    }
    return quickUnlockError(String(error?.message || 'Quick unlock failed.'), fallbackCode, error)
}

function getRecord(state, mode, accountId) {
    if (mode === 'local') return state.local || null
    if (mode !== 'remote') return null

    const key = normalizeAccountId(accountId)
    if (!key) return null
    return state.remote[key] || null
}

function setRecord(state, mode, accountId, record) {
    if (mode === 'local') {
        state.local = record
        return
    }

    const key = normalizeAccountId(accountId)
    if (!key) {
        throw quickUnlockError('Account is required for remote quick unlock.', 'missing-account')
    }

    state.remote[key] = record
}

function deleteRecord(state, mode, accountId) {
    if (mode === 'local') {
        state.local = null
        return
    }

    const key = normalizeAccountId(accountId)
    if (!key) return
    delete state.remote[key]
}

function createCredentialLabel(mode, accountId) {
    if (mode === 'local') return 'Local'
    const account = normalizeAccountId(accountId)
    return account ? `Remote (${account})` : 'Remote'
}

function buildCreateOptions(mode, accountId) {
    const rpId = window.location.hostname
    const label = createCredentialLabel(mode, accountId)

    return {
        publicKey: {
            challenge: randomBytes(32),
            rp: { id: rpId, name: 'Virgulas' },
            user: {
                id: randomBytes(16),
                name: `virgulas-quick-unlock-${Date.now()}`,
                displayName: `Virgulas Quick Unlock ${label}`
            },
            pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 }
            ],
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred'
            },
            timeout: 60000,
            attestation: 'none',
            extensions: {
                prf: {
                    eval: {
                        first: randomBytes(32)
                    }
                }
            }
        }
    }
}

function buildGetOptions(credentialId, prfInputBytes) {
    const rpId = window.location.hostname

    return {
        publicKey: {
            challenge: randomBytes(32),
            rpId,
            allowCredentials: [{
                id: fromBase64Url(credentialId),
                type: 'public-key'
            }],
            userVerification: 'preferred',
            timeout: 60000,
            extensions: {
                prf: {
                    eval: {
                        first: prfInputBytes
                    }
                }
            }
        }
    }
}

async function createCredential(mode, accountId) {
    let credential
    try {
        credential = await navigator.credentials.create(buildCreateOptions(mode, accountId))
    } catch (error) {
        throw mapWebAuthnError(error, 'create-failed')
    }

    if (!credential?.rawId) {
        throw quickUnlockError('Could not create quick unlock credential.', 'create-failed')
    }

    return toBase64Url(new Uint8Array(credential.rawId))
}

async function evaluatePrf(credentialId, prfInputBytes) {
    let assertion
    try {
        assertion = await navigator.credentials.get(buildGetOptions(credentialId, prfInputBytes))
    } catch (error) {
        throw mapWebAuthnError(error, 'assertion-failed')
    }

    if (!assertion) {
        throw quickUnlockError('Quick unlock assertion did not return a credential.', 'assertion-failed')
    }

    const extensionResults = assertion.getClientExtensionResults?.() || {}
    const first = extensionResults?.prf?.results?.first

    if (!first) {
        throw quickUnlockError('Authenticator did not provide PRF output for quick unlock.', 'prf-unavailable')
    }

    const bytes = asUint8Array(first)
    if (!bytes.byteLength) {
        throw quickUnlockError('Authenticator returned empty PRF output.', 'prf-unavailable')
    }

    return bytes
}

function isSupported() {
    return !!(
        window.isSecureContext
        && window.PublicKeyCredential
        && navigator.credentials?.create
        && navigator.credentials?.get
        && window.crypto?.subtle
    )
}

function hasSavedPassphrase({ mode, accountId = '' }) {
    const normalizedMode = normalizeMode(mode)
    if (!normalizedMode) return false

    const state = readState()
    return !!getRecord(state, normalizedMode, accountId)
}

function getStatus({ mode, accountId = '' }) {
    return {
        supported: isSupported(),
        saved: hasSavedPassphrase({ mode, accountId })
    }
}

async function savePassphrase({ mode, accountId = '', passphrase }) {
    const normalizedMode = normalizeMode(mode)
    if (!normalizedMode) {
        throw quickUnlockError('Quick unlock is available only for Local and Remote modes.', 'invalid-mode')
    }

    const normalizedPassphrase = String(passphrase || '')
    if (!normalizedPassphrase) {
        throw quickUnlockError('Passphrase is required before saving quick unlock.', 'missing-passphrase')
    }

    if (!isSupported()) {
        throw quickUnlockError('Quick unlock is not supported in this browser.', 'unsupported')
    }

    const credentialId = await createCredential(normalizedMode, accountId)
    const prfInput = randomBytes(32)
    const prfBytes = await evaluatePrf(credentialId, prfInput)
    const wrappedPassphrase = await encryptSecretWithKeyBytes(normalizedPassphrase, prfBytes)

    const now = Date.now()
    const state = readState()
    setRecord(state, normalizedMode, accountId, {
        version: VERSION,
        credentialId,
        prfInput: toBase64Url(prfInput),
        wrappedPassphrase,
        updatedAt: now,
        createdAt: now
    })
    writeState(state)
}

async function recoverPassphrase({ mode, accountId = '' }) {
    const normalizedMode = normalizeMode(mode)
    if (!normalizedMode) return null

    const state = readState()
    const record = getRecord(state, normalizedMode, accountId)
    if (!record?.credentialId || !record?.wrappedPassphrase) return null

    if (!record?.prfInput) {
        throw quickUnlockError('Saved quick unlock record is outdated.', 'record-invalid')
    }

    const prfInput = fromBase64Url(record.prfInput)
    const prfBytes = await evaluatePrf(record.credentialId, prfInput)

    try {
        return await decryptSecretWithKeyBytes(record.wrappedPassphrase, prfBytes)
    } catch (error) {
        throw quickUnlockError('Saved quick unlock passphrase could not be decrypted.', 'decrypt-failed', error)
    }
}

function removeSavedPassphrase({ mode, accountId = '' }) {
    const normalizedMode = normalizeMode(mode)
    if (!normalizedMode) return

    const state = readState()
    deleteRecord(state, normalizedMode, accountId)
    writeState(state)
}

function clearAllSavedPassphrases() {
    store.quickUnlock.del()
}

function isCancellationError(error) {
    return String(error?.code || '') === 'cancelled'
}

function shouldForgetRecordOnError(error) {
    const code = String(error?.code || '')
    // PRF output can be transiently unavailable; keep the record so unlock can be retried.
    return code === 'credential-missing' || code === 'decrypt-failed' || code === 'record-invalid'
}

export default {
    isSupported,
    getStatus,
    hasSavedPassphrase,
    savePassphrase,
    recoverPassphrase,
    removeSavedPassphrase,
    clearAllSavedPassphrases,
    isCancellationError,
    shouldForgetRecordOnError
}
