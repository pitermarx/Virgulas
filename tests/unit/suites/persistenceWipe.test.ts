import { describe, it } from 'bun:test'
import persistence from '../../../source/js/persistence.js'
import { clearAppCaches, store } from '../../../source/js/utils.js'
import { assert, assertEqual } from '../testing.js'

// priv-01: "Delete local data" (persistence.reset) and "Delete account" must
// wipe every device-local storage slot that holds user data, not just the
// ciphertext. The theme and the non-secret Supabase config are the only slots
// allowed to survive.

/** The only store slots that a wipe is allowed to keep. */
const ALLOWED_SLOTS = ['theme', 'supabase'] as const

function slotNames(): string[] {
    return Object.keys(store)
}

async function seedAllSlots() {
    store.theme.set('dark')
    store.mode.set('local')
    store.user.set('someone@example.com')
    store.syncTs.set('12345')
    store.scheduledWindow.set('7')
    store.inboxNodeName.set('Capture')
    store.storageNoticeDismissed.set('1')
    store.data.set('salt|ciphertext')
    store.inboxQueue.set(JSON.stringify([{ id: 'a', text: 'captured secret text' }]))
}


describe('device wipe (priv-01)', () => {

  it('wipeDeviceData keeps only the allow-listed slots', async () => {
      await clearAppCaches()
      await seedAllSlots()

      persistence.wipeDeviceData()
      // Give the best-effort async cleanups (biometrics, caches) a tick.
      await new Promise((resolve) => setTimeout(resolve, 20))

      for (const name of slotNames()) {
          if ((ALLOWED_SLOTS as readonly string[]).includes(name)) continue
          assert(store[name as keyof typeof store].get(null) === null, `${name} must be removed by the wipe`)
      }
      assertEqual(store.theme.get('light'), 'dark', 'theme survives the wipe')
  })

  it('wipeDeviceData removes the quick-capture queue', async () => {
      await seedAllSlots()
      persistence.wipeDeviceData()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assertEqual(store.inboxQueue.get(null), null, 'the capture queue holds plaintext and must not survive')
  })

  it('wipeDeviceData removes the last username and sync timestamps', async () => {
      await seedAllSlots()
      persistence.wipeDeviceData()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assertEqual(store.user.get(null), null, 'last username survives the wipe')
      assertEqual(store.syncTs.get(null), null, 'sync timestamp survives the wipe')
  })

  it('reset() performs the wipe', async () => {
      await seedAllSlots()
      persistence.reset()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assertEqual(store.inboxQueue.get(null), null, 'reset must clear the capture queue')
      assertEqual(store.syncTs.get(null), null, 'reset must clear the sync timestamp')
      assertEqual(store.inboxNodeName.get(null), null, 'reset must clear the Inbox node name')
      assertEqual(store.scheduledWindow.get(null), null, 'reset must clear the scheduled window')
      assertEqual(store.data.get(null), null, 'reset must clear the ciphertext')
      assertEqual(store.theme.get('light'), 'dark', 'reset keeps the theme')
  })

  it('wipeDeviceData is idempotent', async () => {
      persistence.wipeDeviceData()
      persistence.wipeDeviceData()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assertEqual(store.inboxQueue.get(null), null, 'second wipe finds nothing but must not throw')
  })
})