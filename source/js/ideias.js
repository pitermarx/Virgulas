import { signal, effect, batch } from "https://esm.sh/@preact/signals"
import * as cryptoFn from "./crypto2.js"
import outline from "./outline.js"

const debug = new URLSearchParams(window.location.search).get('debug')
if (debug) document.body.classList.add('debug')

export const log = debug === 'true' ? console.log.bind(console, '[debug]') : () => { }

const salt = signal('')
const passphrase = signal('')

// Persist doc to localStorage on changes, with debounce
effect(() => {
    const version = outline.version() // subscribe to changes
    const saltValue = salt.value
    const passphraseValue = passphrase.value
    if (!saltValue || !passphraseValue) {
        log('No salt or passphrase, skipping encryption')
        return
    }

    const json = outline.serialize() // get latest doc state

    const persistenceId = setTimeout(async () => {
        try {
            log('Compressing and encrypting doc v' + version + '...')
            const encrypted = await cryptoFn.encrypt(json, passphraseValue, saltValue)
            log('Encrypted doc v' + version + ' length=', encrypted.length)
            localStorage.setItem('vmd_data_enc', saltValue + '|' + encrypted)
        } catch (error) {
            console.error('Error encrypting doc v' + version + ':', error)
        }
    }, 2000)

    return () => {
        log('Doc v' + version + ' changed, clearing pending persistence')
        clearTimeout(persistenceId)
    }
})

export function reset() {
    outline.reset()
    lock()
}

export async function lock() {
    passphrase.value = ''
    salt.value = ''
}

export async function unlock(code, encryptedData) {
    let saltValue = cryptoFn.generateSalt()
    encryptedData = encryptedData || localStorage.getItem('vmd_data_enc')
    if (encryptedData) {
        const idx = encryptedData.indexOf('|')
        if (idx === -1) {
            log('Invalid encrypted data format, missing "|" salt separator')
            return false
        }
        saltValue = encryptedData.substring(0, idx)
        encryptedData = encryptedData.substring(idx + 1)
    }
    try {
        const json = encryptedData ? await cryptoFn.decrypt(encryptedData, code, saltValue) : null

        if (!json) {
            log('No encrypted data found, starting with empty doc')
        }

        batch(() => {
            passphrase.value = code
            salt.value = saltValue
            json && outline.deserialize(json)
        })
        return true
    }
    catch (error) {
        console.error('Error unlocking doc:', error)
        return false
    }
}