// The lock screen: the storage wizard, the unlock/sign-up/reset flows and the
// lock screen component itself.
//
// Its state lives here, not in the app shell. `app.ts` mounts `LockScreen` and
// reads `isWizardOverlayOpen()`; Options reaches the same state through
// `lockNow` / `resetSessionState`, and persistence.loadIntroDocument(). `authMode` is
// re-exported from `persistence.ts`, which owns it.

import { effect, signal } from '@preact/signals'
import { html } from 'htm/preact'
import outline, { CorruptDocumentError } from './outline.js'
import type { OutlineDoc } from './model.js'
import persistence, { authMode, remoteRekeyedNotice } from './persistence.js'
import type { PersistenceMode } from './persistence.js'
import { store } from './utils.js'
import { backendKind, backendUrl, remoteResetAvailable, remoteSync } from './sync.js'
import { biometrics } from './biometrics.js'
import { captureOnly } from './capture.js'
import { CorruptEnvelopeError, WrongPassphraseError } from './crypto2.js'

const authHasLocalData = signal(false)
const authHasEncryptedStorage = signal(true)
export const browserSupportWarning = signal('')
const username = signal('')
const password = signal('')
const passphrase = signal('')
const unlockError = signal('')
const unlockMessage = signal('')
/** The last failed unlock attempt; the reset buttons are derived from its type. */
const unlockFailure = signal<unknown>(null)
const isBusy = signal(false)
// The lock sheet's flow: one value instead of authStep + wizardOverlay +
// wizardStep + remotePasswordStage. The wizard asks the location first (device
// vs cloud) and then the concrete local kind; the cloud path goes straight to
// the credentials form because the server resolves itself. `overlay` is the same
// wizard drawn over the live memory session: nothing is locked or captured until
// the user commits to a storage mode.
type WizardStep = 'location' | 'device'
type LockFlow =
  | { kind: 'unlock' }
  | { kind: 'remote-password' } // email+password collected, awaiting the passphrase
  | { kind: 'wizard'; step: WizardStep }
  | { kind: 'overlay'; step: WizardStep }
const lockFlow = signal<LockFlow>({ kind: 'unlock' })
const authUser = signal<any>(null)
const autoBioAttempted = signal(false)
/** Names the resolved sync server for the credentials form. */
const serverLabel = (): string => {
  if (backendKind() !== 'trailbase') return 'the Virgulas cloud'
  if (!backendUrl()) return 'this server'
  try { return new URL(backendUrl()).host } catch { return backendUrl() }
}

const isRemoteSessionValid = () => authMode.value === 'remote' && !!authUser.value
const isLocalCreate = () => authMode.value === 'local' && !authHasLocalData.value

export async function initAuthState(options: { forceLockScreen?: boolean } = {}) {
  const bootstrap = await persistence.getAuthBootstrap(options)
  authMode.value = bootstrap.mode as PersistenceMode
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
    await persistence.loadLockedBackgroundIntro()
  }
}

// sync-01 (docs §4.4): a pull met a remote rotated on another device, so the
// session locked itself. Prompt for the new passphrase on the lock screen
// instead of leaving the user with a silent lock.
effect(() => {
  if (!remoteRekeyedNotice.value) return;
  remoteRekeyedNotice.value = false;
  unlockError.value = 'The passphrase was changed on another device. Enter the new passphrase to continue.';
});

let stagedMemoryDoc: OutlineDoc | null = null;

function setWizardStep(step: WizardStep) {
  const flow = lockFlow.peek()
  if (flow.kind === 'wizard' || flow.kind === 'overlay') lockFlow.value = { kind: flow.kind, step }
}

const isWizardFlow = (flow: LockFlow) => flow.kind === 'wizard' || flow.kind === 'overlay'

async function requestChangeMode() {
  if (authMode.value === 'local' && authHasLocalData.value) {
    if (!confirm('Switching mode will clear your local encrypted data from this device. Continue?')) return;
    persistence.clearLocalData();
    authHasLocalData.value = false;
  } else if (authMode.value === 'remote' && authUser.value) {
    if (!confirm('Switching mode will sign you out of the remote session. Continue?')) return;
    await persistence.signOut();
    authUser.value = null;
  }
  lockFlow.value = { kind: 'wizard', step: 'location' };
  unlockError.value = '';
  unlockMessage.value = '';
  unlockFailure.value = null;
  passphrase.value = '';
  password.value = '';
  autoBioAttempted.value = false;
}

function pickMode(nextMode: PersistenceMode) {
  if ((nextMode === 'local' || nextMode === 'remote') && !authHasEncryptedStorage.value) {
    unlockError.value = browserSupportWarning.value || 'Encrypted Local and Remote storage are unavailable in this browser.';
    return;
  }
  if (nextMode === 'filesystem' && !persistence.hasFilesystem()) {
    unlockError.value = 'File System Access API is not supported in this browser.';
    return;
  }
  authMode.value = nextMode;
  persistence.setPreferredMode(nextMode);
  unlockError.value = '';
  unlockFailure.value = null;
  passphrase.value = '';
  password.value = '';
  lockFlow.value = { kind: 'unlock' };
  autoBioAttempted.value = false;
}

async function submitUnlock(e: any) {
  e.preventDefault();
  if (isBusy.value) return;
  unlockError.value = '';
  unlockMessage.value = '';
  unlockFailure.value = null;
  isBusy.value = true;
  try {
    if (authMode.value === 'filesystem') {
      await persistence.unlock('', {
        mode: 'filesystem',
        // A file chosen while a memory document is running adopts it instead
        // of being reset to one empty node (same as Local/Remote setup).
        initialDoc: stagedMemoryDoc ?? undefined
      });
      stagedMemoryDoc = null;
      document.body.setAttribute('data-main-view', 'rendered');
      return;
    }

    if (!passphrase.value.trim()) {
      unlockError.value = 'Passphrase cannot be empty.';
      return;
    }

    const success = await persistence.unlock(passphrase.value, {
      mode: authMode.value,
      username: username.value,
      password: password.value,
      trustSession: isRemoteSessionValid(),
      // Setting up storage from a running memory document (the intro tour,
      // with the user's edits) carries it over instead of the seed doc.
      initialDoc: stagedMemoryDoc ?? undefined
    });
    if (success) {
      // The passphrase now lives only in KeySession: drop the form copy instead
      // of keeping it in memory for the rest of the session.
      passphrase.value = '';
      stagedMemoryDoc = null;
      lockFlow.value = { kind: 'unlock' };
      if (authMode.value === 'remote') {
        authUser.value = await persistence.getUser();
      }
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Unable to unlock this storage mode.';
    }
  } catch (error) {
    const message = String((error as { message?: string } | null)?.message || 'Failed to unlock.');
    unlockError.value = message;
    unlockFailure.value = error;
  } finally {
    isBusy.value = false;
  }
}

async function submitSignUp() {
  unlockError.value = '';
  unlockMessage.value = '';
  if (!username.value.trim() || !password.value) {
    unlockError.value = 'Username and password are required.';
    return;
  }
  isBusy.value = true;
  try {
    const result = await persistence.signUp(username.value, password.value);
    authUser.value = await persistence.getUser();

    // Supabase returns a user object but no session when email confirmation is
    // required. Without this branch the app silently continued and the unlock
    // attempt later failed with "Could not validate remote session", which made
    // cloud sync look broken. Stay on the credentials step (email prefilled):
    // the user's next action is confirming and signing in, not a passphrase.
    if (persistence.needsEmailConfirmation()) {
      // TrailBase's register reports success even when the account already
      // exists (anti-enumeration); the verification email only goes out for
      // new accounts, so "check your inbox" stays honest either way.
      unlockMessage.value = 'Sign-up submitted. Check your inbox and confirm your email address, then sign in.';
      return;
    }

    if (!result?.user) {
      unlockMessage.value = 'Sign-up submitted. Confirm your email if confirmation is enabled.';
    }
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to sign up.');
  } finally {
    isBusy.value = false;
  }
}

async function submitForgotPassword() {
  unlockError.value = '';
  unlockMessage.value = '';
  const email = username.value.trim();
  if (!email) {
    unlockError.value = 'Enter your email first, then press Forgot password.';
    return;
  }
  isBusy.value = true;
  try {
    await persistence.requestPasswordReset(email);
    // Anti-enumeration: the backend reports success even for unknown
    // accounts, so the message never claims an account was found.
    unlockMessage.value = `Password reset email sent to ${email}. Follow the link in it to set a new password, then sign in.`;
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to send the password reset email.');
  } finally {
    isBusy.value = false;
  }
}

async function submitSignOut() {
  unlockError.value = '';
  unlockMessage.value = '';
  isBusy.value = true;
  try {
    await persistence.signOut();
    authUser.value = null;
    lockFlow.value = { kind: 'unlock' };
    await persistence.unlock('', { mode: 'memory' });
    persistence.setPreferredMode('memory');
    stagedMemoryDoc = null;
    document.body.setAttribute('data-main-view', 'rendered');
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to sign out.');
  } finally {
    isBusy.value = false;
  }
}

async function submitResetLocalData() {
  unlockError.value = '';
  unlockMessage.value = '';
  if (!passphrase.value.trim()) {
    unlockError.value = 'Enter a new passphrase before resetting local data.';
    return;
  }
  const confirmed = confirm('This replaces your local encrypted data with a new empty document. Continue?');
  if (!confirmed) return;

  isBusy.value = true;
  try {
    persistence.clearLocalData();
    authHasLocalData.value = false;
    unlockFailure.value = null;
    const success = await persistence.unlock(passphrase.value, {
      mode: 'local',
      initialDoc: stagedMemoryDoc ?? undefined
    });
    if (success) {
      passphrase.value = '';
      stagedMemoryDoc = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Failed to create new local data.';
    }
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to reset local data.');
  } finally {
    isBusy.value = false;
  }
}

async function submitResetRemoteData() {
  unlockError.value = '';
  unlockMessage.value = '';
  if (!passphrase.value.trim()) {
    unlockError.value = 'Enter a new passphrase before resetting remote data.';
    return;
  }
  const confirmed = confirm('This replaces your remote encrypted data with a new empty document. Continue?');
  if (!confirmed) return;

  isBusy.value = true;
  try {
    await persistence.resetRemoteData(passphrase.value, {
      username: username.value,
      password: password.value
    });
    passphrase.value = '';
    unlockFailure.value = null;
    document.body.setAttribute('data-main-view', 'rendered');
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to reset remote data.');
  } finally {
    isBusy.value = false;
  }
}

async function continueInMemory() {
  lockFlow.value = { kind: 'unlock' };
  const staged = stagedMemoryDoc;
  stagedMemoryDoc = null;
  await persistence.unlock('', { mode: 'memory' });
  persistence.setPreferredMode('memory');
  if (staged) {
    outline.load(staged);
  } else {
  }
  document.body.setAttribute('data-main-view', 'rendered');
}

/** Opens the storage wizard from the Enable Secure Storage banner: the
 * running memory session stays live behind the sheet — the document is only
 * captured when a storage mode is committed to (commitToWizardMode). */
function openStorageWizard() {
  lockFlow.value = { kind: 'overlay', step: 'location' };
  authMode.value = 'memory';
  autoBioAttempted.value = false;
  unlockError.value = '';
  unlockMessage.value = '';
  unlockFailure.value = null;
  password.value = '';
  passphrase.value = '';
}

/** Abandons the wizard over a live session: the running document is untouched. */
function closeStorageWizard() {
  lockFlow.value = { kind: 'unlock' };
  unlockError.value = '';
}

/** The user commits to a storage mode: capture the running memory document
 * now (its one exit from memory), lock the session for setup, and continue
 * into the mode's unlock/creation flow, which adopts the staged doc. A
 * locked entry (Change mode) has no live document to stage. */
async function commitToWizardMode(nextMode: PersistenceMode) {
  unlockError.value = '';
  if (nextMode === 'memory') {
    if (lockFlow.peek().kind === 'overlay') {
      // Already live in memory: the wizard is just an overlay — dismiss it.
      closeStorageWizard();
      return;
    }
    // Locked entry: the old "skip to memory" semantics.
    await continueInMemory();
    return;
  }
  if (persistence.isMemory()) {
    stagedMemoryDoc = outline.snapshot();
  }
  if (!persistence.isLocked()) {
    await persistence.lock();
  }
  if (nextMode === 'remote') void remoteSync.resolveBackend();
  pickMode(nextMode);
}

async function submitRemotePassword(e: any) {
  e.preventDefault();
  if (isBusy.value) return;
  if (!username.value.trim() || !password.value) {
    unlockError.value = 'Email and password are required.';
    return;
  }
  unlockError.value = '';
  unlockMessage.value = '';
  isBusy.value = true;
  try {
    // Authenticate the account now so invalid credentials surface at this step,
    // instead of only after the user has already entered their encryption passphrase.
    await remoteSync.signIn(username.value.trim(), password.value);
    authUser.value = await persistence.getUser();
    if (!authUser.value) {
      unlockError.value = 'Sign-in failed. Check your email and password.';
      return;
    }
    // A successful sign-in clears any earlier "confirm your email" state.
    persistence.clearEmailConfirmation();
    store.user.set(username.value.trim());
    lockFlow.value = { kind: 'remote-password' };
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Sign-in failed. Check your email and password.');
  } finally {
    isBusy.value = false;
  }
}

async function unlockWithBiometrics() {
  if (isBusy.value) return;
  isBusy.value = true;
  unlockError.value = '';
  try {
    const recovered = await biometrics.unlock();
    if (!recovered) {
      unlockError.value = 'Biometric unlock failed. Enter your passphrase instead.';
      return;
    }
    const success = await persistence.unlock(recovered, {
      mode: authMode.value,
      username: username.value,
      password: password.value,
      trustSession: isRemoteSessionValid()
    });
    if (success) {
      // KeySession now holds the secret; never mirror the recovered passphrase
      // into the lock-screen form state.
      passphrase.value = '';
      lockFlow.value = { kind: 'unlock' };
      if (authMode.value === 'remote') {
        authUser.value = await persistence.getUser();
      }
      stagedMemoryDoc = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Invalid passphrase.';
    }
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Biometric unlock failed.');
  } finally {
    isBusy.value = false;
  }
}

effect(() => {
  // Capture-only visits stay locked on purpose and must not prompt for WebAuthn.
  if (captureOnly.value) return;

  const isLocked = persistence.isLocked();
  if (!isLocked) {
    autoBioAttempted.value = false;
    return;
  }

  const flow = lockFlow.value;
  const mode = authMode.value;
  const enrolled = biometrics.enrolled.value;
  const busy = isBusy.value;
  const isFilesystem = mode === 'filesystem';
  const isRemote = mode === 'remote';
  const isSessionValid = isRemoteSessionValid();
  const needsRemoteCredentials = isRemote && !isSessionValid && flow.kind !== 'remote-password';
  const localCreate = mode === 'local' && !authHasLocalData.value;

  if (
    (flow.kind === 'unlock' || flow.kind === 'remote-password') &&
    enrolled &&
    !busy &&
    !isFilesystem &&
    !localCreate &&
    !needsRemoteCredentials &&
    !autoBioAttempted.value
  ) {
    autoBioAttempted.value = true;
    void unlockWithBiometrics();
  }
});

export const LockScreen = () => {
  const flow = lockFlow.value;
  const inWizard = isWizardFlow(flow);
  const wizardStep = inWizard ? flow.step : 'location';
  const overlay = flow.kind === 'overlay';
  const mode = authMode.value;
  const isFilesystem = mode === 'filesystem';
  const isRemote = mode === 'remote';
  const isLocal = mode === 'local';
  const isSessionValid = isRemoteSessionValid();

  const needsRemoteCredentials = isRemote && !isSessionValid && flow.kind !== 'remote-password';

  const passwordStepDisabled = isBusy.value || !username.value.trim() || !password.value;
  const unlockDisabled = isBusy.value || (!isFilesystem && !passphrase.value.trim());

  const modeLabel = isLocal ? 'Local' : isRemote ? 'Remote' : 'File';

  const failure = unlockFailure.value;
  const canResetLocal = isLocal && (failure instanceof CorruptEnvelopeError || failure instanceof CorruptDocumentError);
  const canResetRemote = isRemote && failure instanceof WrongPassphraseError;

  return html`
    <div class="bottom-sheet" data-auth-mode=${mode} role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-content">
        ${browserSupportWarning.value && html`<div class="form-error" role="alert">${browserSupportWarning.value}</div>`}

        ${inWizard && html`
          <h2 class="auth-title" id="auth-title">
            ${wizardStep === 'location' ? 'Where should your notes live?' : 'On this device'}
          </h2>

          ${wizardStep === 'location' && html`
            <div class="wizard-options" role="group" aria-label="Storage location">
              <button type="button" class="wizard-option" onClick=${() => setWizardStep('device')}>
                <span class="backend-option-text">
                  <span class="backend-name">On this device</span>
                  <span class="backend-desc">Private to this browser — encrypted, a file, or memory only</span>
                </span>
              </button>
              <button type="button" class="wizard-option" onClick=${() => void commitToWizardMode('remote')}
                disabled=${!authHasEncryptedStorage.value}>
                <span class="backend-option-text">
                  <span class="backend-name">In the cloud</span>
                  <span class="backend-desc">Sign in or sign up — end-to-end encrypted, synced across devices</span>
                </span>
              </button>
            </div>
            <div class="auth-memory-skip">
              <button type="button" class="auth-memory-link" onClick=${overlay ? closeStorageWizard : continueInMemory} disabled=${isBusy.value}>
                ${overlay ? 'Skip — keep notes in memory' : 'Skip — continue in memory'}
              </button>
            </div>
          `}

          ${wizardStep === 'device' && html`
            <div class="wizard-options" role="group" aria-label="Local storage kind">
              <button type="button" class="wizard-option" onClick=${() => void commitToWizardMode('local')}
                disabled=${!authHasEncryptedStorage.value}>
                <span class="backend-option-text">
                  <span class="backend-name">Encrypted storage — recommended</span>
                  <span class="backend-desc">Passphrase-protected in this browser; survives reloads and restarts</span>
                </span>
              </button>
              <button type="button" class="wizard-option" onClick=${() => void commitToWizardMode('filesystem')}>
                <span class="backend-option-text">
                  <span class="backend-name">A .vmd file</span>
                  <span class="backend-desc">Plain text you choose and keep — not encrypted; you handle backups</span>
                </span>
              </button>
              <button type="button" class="wizard-option" onClick=${() => void commitToWizardMode('memory')} disabled=${isBusy.value}>
                <span class="backend-option-text">
                  <span class="backend-name">Memory only</span>
                  <span class="backend-desc">Nothing is saved — your notes are gone when the tab closes</span>
                </span>
              </button>
            </div>
          `}

          ${unlockError.value && html`<div class="form-error" role="alert">${unlockError.value}</div>`}
          ${wizardStep !== 'location' && html`
            <div class="auth-memory-skip">
              <button type="button" class="auth-memory-link" onClick=${() => { setWizardStep('location'); unlockError.value = ''; }}>
                Back
              </button>
            </div>
          `}
        `}

        ${!inWizard && html`
          <h2 class="auth-title" id="auth-title">Unlock Virgulas</h2>
          <div class="status-text">
            ${isLocal && (isLocalCreate() ? 'Secure Your Workspace' : 'Encrypted Local Storage')}
            ${isRemote && (isSessionValid ? 'Remote — ' + (authUser.value?.email || '') : 'Remote — ' + serverLabel())}
            ${isFilesystem && 'File'}
          </div>

          ${needsRemoteCredentials && html`
            <form onSubmit=${submitRemotePassword}>
              <div class="input-group">
                <label for="auth-username" class="input-label">Email</label>
                <input value=${username.value} onInput=${(e: any) => username.value = e.target.value}
                  id="auth-username" type="text" placeholder="you@example.com" class="input-field" autocomplete="email" />
              </div>
              <div class="input-group">
                <label for="auth-password" class="input-label">Account password</label>
                <input value=${password.value} onInput=${(e: any) => password.value = e.target.value}
                  id="auth-password" type="password" placeholder="Account password" class="input-field" autocomplete="current-password"
                  aria-invalid=${unlockError.value ? 'true' : undefined}
                  aria-describedby=${unlockError.value ? 'auth-password-error' : undefined} />
              </div>
              ${unlockError.value && html`<div class="form-error" id="auth-password-error" role="alert">${unlockError.value}</div>`}
              ${unlockMessage.value && html`<div class="form-success" role="status">${unlockMessage.value}</div>`}
              <button type="submit" class="lock-submit-btn" disabled=${passwordStepDisabled} aria-label="Continue" title="Continue">
                ${isBusy.value ? '...' : 'Continue'}
              </button>
            </form>

            <div class="auth-secondary-actions">
              <button type="button" class="toolbar-btn" disabled=${isBusy.value || !username.value.trim() || !password.value}
                onClick=${submitSignUp}>
                ${isBusy.value ? '...' : 'Sign up'}
              </button>
              ${remoteResetAvailable.value && html`
                <button type="button" class="auth-memory-link" disabled=${isBusy.value || !username.value.trim()}
                  onClick=${submitForgotPassword} title="Email a password reset link">
                  Forgot password?
                </button>
              `}
            </div>
          `}

          ${!needsRemoteCredentials && html`
            ${isRemote && isSessionValid && html`
              <div class="auth-secondary-actions">
                <button type="button" class="toolbar-btn" disabled=${isBusy.value} onClick=${submitSignOut}>
                  ${isBusy.value ? 'Signing out...' : 'Sign out'}
                </button>
              </div>
            `}

            ${flow.kind === 'remote-password' && html`
              <div class="auth-secondary-actions">
                <button type="button" class="toolbar-btn" disabled=${isBusy.value}
                  onClick=${() => { lockFlow.value = { kind: 'unlock' }; unlockError.value = ''; }}>Back</button>
              </div>
            `}

            <form onSubmit=${submitUnlock}>
              ${!isFilesystem && html`
                <label for="auth-passphrase" class="visually-hidden">
                  ${isLocalCreate() ? 'Create a passphrase' : 'Encryption passphrase'}
                </label>
                <input
                  value=${passphrase.value}
                  onInput=${(e: any) => passphrase.value = e.target.value}
                  id="auth-passphrase"
                  type="password"
                  placeholder=${isLocalCreate() ? 'Create passphrase' : 'Passphrase'}
                  class="huge-input"
                  autocomplete=${isLocalCreate() ? 'new-password' : 'current-password'}
                  aria-invalid=${unlockError.value ? 'true' : undefined}
                  aria-describedby=${unlockError.value ? 'auth-unlock-error' : undefined}
                />
                <p class="auth-hint">If you lose this passphrase, your data cannot be recovered — not even by Virgulas.</p>
              `}
              ${unlockMessage.value && html`<div class="form-success" role="status">${unlockMessage.value}</div>`}
              ${unlockError.value && html`<div class="form-error" id="auth-unlock-error" role="alert">${unlockError.value}</div>`}
              ${canResetLocal && html`
                <div class="auth-secondary-actions">
                  <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
                    onClick=${submitResetLocalData}>Reset Local Data With New Passphrase</button>
                </div>
              `}
              ${canResetRemote && html`
                <div class="auth-secondary-actions">
                  <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
                    onClick=${submitResetRemoteData}>Reset Remote Data With New Passphrase</button>
                </div>
              `}
              <button type="submit" class="lock-submit-btn" disabled=${unlockDisabled} aria-label="Unlock" title="Unlock">
                ${isBusy.value ? '...' : isFilesystem ? 'Open File' : 'Unlock'}
              </button>
            </form>
          `}

          <button type="button" class="subtle-switch" onClick=${requestChangeMode} disabled=${isBusy.value}>
            Change mode (${modeLabel})
          </button>
          <div class="auth-memory-skip">
            <button type="button" class="auth-memory-link" onClick=${continueInMemory} disabled=${isBusy.value}>
              Skip — continue in memory
            </button>
          </div>
        `}

      </div>
    </div>
  `;
};

export const SecureStoragePrompt = () => {
  if (persistence.isLocked() || !persistence.isMemory() || !authHasEncryptedStorage.value) return null;

  return html`
    <button type="button" class="app-node" onClick=${openStorageWizard}>
      <div class="app-node-icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <div>
        <div class="app-node-text">Enable Secure Storage</div>
        <div class="app-node-sub">Your document is currently only in memory. Tap to save locally.</div>
      </div>
    </button>
  `;
};

// ── API used by the Options modal ────────────────────────────────────────────

/** Close the session and show the lock screen (the Options "Lock" action). */
export async function lockNow() {
  await persistence.lock()
  authMode.value = 'local'
  lockFlow.value = { kind: 'unlock' }
  autoBioAttempted.value = false
  await persistence.loadLockedBackgroundIntro()
}

/** Clear the auth state after a sign-out, purge or account deletion. */
export function resetSessionState() {
  authUser.value = null
  authHasLocalData.value = false
  lockFlow.value = { kind: 'unlock' }
  stagedMemoryDoc = null
  unlockError.value = ''
  unlockMessage.value = ''
}

/** The wizard overlay is drawn over the live memory session. */
export const isWizardOverlayOpen = () => lockFlow.value.kind === 'overlay'

