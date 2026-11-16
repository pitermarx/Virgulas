// The lock/session state and boot helpers.
//
// Everything here is shared by the lock screen, the storage wizard and the
// Options modal, and set by both boot and the auth actions. It lives in one
// module so those surfaces read the same state instead of mirroring it.
//
// `authMode` is re-exported from `persistence.ts`, which owns it: the app used
// to keep a second copy and assign both.

import { signal } from '@preact/signals'
import outline from './outline.js'
import persistence, { authMode } from './persistence.js'
import type { PersistenceMode } from './persistence.js'
import { clearAppCaches } from './utils.js'
import { backendKind, backendUrl } from './sync.js'

export { authMode } from './persistence.js'

export const authScenario = signal('empty-local')
export const authHasLocalData = signal(false)
export const authHasEncryptedStorage = signal(true)
export const browserSupportWarning = signal('')
export const username = signal('')
export const password = signal('')
export const passphrase = signal('')
export const unlockError = signal('')
export const unlockMessage = signal('')
export const canResetRemoteData = signal(false)
export const canResetLocalData = signal(false)
export const isBusy = signal(false)
// The choose-mode sheet is a wizard: path first (device vs cloud), then the
// concrete local storage choice. The cloud path goes straight to the
// credentials form — the server resolves itself.
export const wizardStep = signal<'storage' | 'local'>('storage')
// The banner opens the wizard OVER the live memory session: nothing is locked
// or captured until the user commits to a storage mode.
export const wizardOverlay = signal(false)
export const authUser = signal<any>(null)
export const authStep = signal('unlock')
// Remote unlock staging: email+password were collected and we await the passphrase.
export const remotePasswordStage = signal(false)
export const bioEnrolled = signal(false)
export const autoBioAttempted = signal(false)
export const accountInfo = signal({ email: '', mode: '', encryptedBytes: 0 })
/** True when the resolved Remote backend can delete the auth record itself
 * (TrailBase). Supabase keeps it — deleting `auth.users` needs the service
 * role — so the Options copy and the confirmation say which one happens. */
export const accountDeletesUser = signal(false)

/** Names the resolved sync server for the credentials form. */
export const serverLabel = (): string => {
  if (backendKind() !== 'trailbase') return 'the Virgulas cloud'
  if (!backendUrl()) return 'this server'
  try { return new URL(backendUrl()).host } catch { return backendUrl() }
}

export const isRemoteSessionValid = () =>
  authMode.value === 'remote' && authScenario.value === 'remote-session-valid' && !!authUser.value
export const isLocalCreate = () => authMode.value === 'local' && !authHasLocalData.value

let cachedIntroText: string | null = null

export async function getIntroText() {
  if (cachedIntroText !== null) return cachedIntroText
  try {
    const resp = await fetch('/intro.vmd')
    cachedIntroText = resp.ok ? await resp.text() : ''
  } catch {
    cachedIntroText = ''
  }
  return cachedIntroText
}

export async function loadLockedBackgroundIntro() {
  const introText = await getIntroText()
  outline.reset()
  if (introText && introText.trim()) {
    outline.setRootVMD(introText)
  } else {
    outline.addChild('root', { text: '' })
  }
}

export async function initAuthState(options: { forceLockScreen?: boolean } = {}) {
  const bootstrap = await persistence.getAuthBootstrap(options)
  authMode.value = bootstrap.mode as PersistenceMode
  authScenario.value = bootstrap.scenario
  authHasLocalData.value = bootstrap.hasLocalData
  authHasEncryptedStorage.value = bootstrap.encryptedStorageAvailable
  browserSupportWarning.value = bootstrap.browserSupportWarning
  username.value = bootstrap.lastUsername || ''
  authUser.value = bootstrap.user || null

  // Memory mode: skip the lock screen entirely.
  if (bootstrap.mode === 'memory') {
    await persistence.unlock('', { mode: 'memory' })
    document.body.setAttribute('data-main-view', 'rendered')
    return
  }

  if (persistence.isLocked()) {
    await loadLockedBackgroundIntro()
  }
}

/**
 * Land in memory mode after a wipe. Clear Cache Storage last and await it, so
 * a purge really leaves no app-owned cache behind.
 */
export async function bootMemoryAfterWipe() {
  await persistence.unlock('', { mode: 'memory' })
  persistence.setPreferredMode('memory')
  await clearAppCaches()
}
