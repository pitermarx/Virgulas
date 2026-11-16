import { describe, it, beforeEach } from 'bun:test'
import {
    dismissLocalStoragePersistenceNotice,
    localStorageDurability,
    localStoragePersistenceNotice,
    refreshLocalStorageDurability
} from '../../../source/js/durability.js'
import { store } from '../../../source/js/utils.js'
import { assertEqual } from '../testing.js'

function stubPersistence(persisted: boolean) {
    Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { persisted: async () => persisted, persist: async () => persisted }
    })
}

beforeEach(() => {
    Object.defineProperty(navigator, 'vendor', { configurable: true, value: 'Google Inc.' })
    delete (navigator as any).standalone
    store.storageNoticeDismissed.del()
    localStoragePersistenceNotice.value = false
    localStorageDurability.value = 'best-effort'
})

describe('local-storage durability', () => {

    it('reports a genuinely persistent browser as persistent', async () => {
        stubPersistence(true)
        await refreshLocalStorageDurability(true)
        assertEqual(localStorageDurability.value, 'persistent', 'persisted() is trusted')
        assertEqual(localStoragePersistenceNotice.value, false, 'no reminder for a persistent store')
    })

    it('marks an Apple browser tab best-effort even when persisted() resolves true', async () => {
        Object.defineProperty(navigator, 'vendor', { configurable: true, value: 'Apple Computer, Inc.' })
        stubPersistence(true)
        await refreshLocalStorageDurability(true)
        assertEqual(localStorageDurability.value, 'best-effort', 'a Safari tab can be evicted')
        assertEqual(localStoragePersistenceNotice.value, true, 'the reminder explains it')
    })

    it('trusts a standalone Apple app', async () => {
        Object.defineProperty(navigator, 'vendor', { configurable: true, value: 'Apple Computer, Inc.' })
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
        stubPersistence(true)
        await refreshLocalStorageDurability(false)
        assertEqual(localStorageDurability.value, 'persistent', 'an installed app is not a tab')
    })

    it('a dismissed reminder stays away', async () => {
        stubPersistence(false)
        await refreshLocalStorageDurability(true)
        assertEqual(localStoragePersistenceNotice.value, true, 'best-effort shows the reminder')

        dismissLocalStoragePersistenceNotice()
        assertEqual(localStoragePersistenceNotice.value, false, 'dismiss hides it')
        assertEqual(store.storageNoticeDismissed.get(), '1', 'the choice is remembered')

        await refreshLocalStorageDurability(true)
        assertEqual(localStoragePersistenceNotice.value, false, 'it does not come back')
    })
})
