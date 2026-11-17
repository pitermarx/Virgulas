// The Options modal: account, encryption, biometrics, quick capture and data
// actions.
//
// Its state is private to this module; the lock screen is reached only through
// the small API it exports (lock now, reset after a wipe), and persistence owns
// mode, stores and the memory-mode boot.

import { effect, signal } from '@preact/signals'
import { html } from 'htm/preact'
import persistence from './persistence.js'
import { biometrics } from './biometrics.js'
import { remoteSync } from './sync.js'
import { store, appVersion } from './utils.js'
import { DEFAULT_ITERATIONS } from './crypto2.js'
import inbox from './inbox.js'
import { inboxNodeName } from './capture.js'
import { bindDialogFocus } from './dialogs.js'
import { optionsOpen } from './shortcuts.js'
import { modes, isEncryptedMode } from './modes.js'
import { loadIntroDocument } from './intro.js'
import { lockNow, resetSessionState } from './lockScreen.js'

const accountInfo = signal({ email: '', mode: '', encryptedBytes: 0 })
/** True when the backend can delete the auth record itself (TrailBase). */
const accountDeletesUser = signal(false)
const busy = signal(false)

const adminError = signal('');
const adminMessage = signal('');
const newEmail = signal('');
const newPassword = signal('');
const newPassphrase = signal('');
const editingOption = signal<'email' | 'password' | 'passphrase' | null>(null);
const bookmarkletCopied = signal(false);
let bookmarkletCopiedTimer: ReturnType<typeof setTimeout> | null = null;

function captureAppUrl() {
  if (typeof window === 'undefined') return '/';
  return `${window.location.origin}${window.location.pathname}`;
}

const bookmarkletHref = inbox.buildBookmarklet(captureAppUrl());

// The bookmarklet is a single control: clicking copies its source so it can be
// pasted into a bookmark, while dragging (native anchor drag) installs it.
async function handleBookmarkletClick(event: any) {
  event.preventDefault();
  try {
    await navigator.clipboard.writeText(bookmarkletHref);
    bookmarkletCopied.value = true;
    if (bookmarkletCopiedTimer !== null) clearTimeout(bookmarkletCopiedTimer);
    bookmarkletCopiedTimer = setTimeout(() => {
      bookmarkletCopied.value = false;
      bookmarkletCopiedTimer = null;
    }, 3000);
  } catch {
    adminError.value = 'Could not copy the bookmarklet. Drag it onto your bookmarks bar instead.';
  }
}

async function refreshAccountInfo() {
  let user: any = null;
  try { user = await persistence.getUser(); } catch { /* ignore */ }
  let deletesUser = false;
  if (persistence.getMode() === 'remote') {
    try { deletesUser = await remoteSync.hasDeleteUser(); } catch { /* keep the conservative copy */ }
  }
  accountDeletesUser.value = deletesUser;
  accountInfo.value = {
    email: user?.email || '',
    mode: persistence.getMode(),
    encryptedBytes: (store.data.get('') || '').length
  };
}

effect(() => {
  if (optionsOpen.value) {
    editingOption.value = null;
    void refreshAccountInfo();
    void biometrics.hasEnrolled();
  }
});

if (typeof window !== 'undefined' && biometrics.isSupported()) {
  void biometrics.hasEnrolled();
}

async function runAdminAction(action: () => Promise<unknown>, successMessage: string) {
  adminError.value = '';
  adminMessage.value = '';
  busy.value = true;
  try {
    await action();
    adminMessage.value = successMessage;
    await refreshAccountInfo();
  } catch (error) {
    adminError.value = String((error as { message?: string } | null)?.message || 'Something went wrong.');
  } finally {
    busy.value = false;
  }
}

function submitChangeEmail(e: any) {
  e.preventDefault();
  if (!newEmail.value.trim()) {
    adminError.value = 'Email cannot be empty.';
    return;
  }
  const next = newEmail.value.trim();
  newEmail.value = '';
  editingOption.value = null;
  void runAdminAction(() => remoteSync.updateEmail(next), 'Email updated. Confirm the change from the new address if required.');
}

function submitChangePassword(e: any) {
  e.preventDefault();
  if (!newPassword.value) {
    adminError.value = 'Password cannot be empty.';
    return;
  }
  const next = newPassword.value;
  newPassword.value = '';
  editingOption.value = null;
  void runAdminAction(() => remoteSync.updatePassword(next), 'Account password updated.');
}

function submitChangePassphrase(e: any) {
  e.preventDefault();
  if (!newPassphrase.value) {
    adminError.value = 'New passphrase cannot be empty.';
    return;
  }
  const next = newPassphrase.value;
  newPassphrase.value = '';
  editingOption.value = null;
  void runAdminAction(() => persistence.changePassphrase(next), 'Encryption passphrase changed. Data was re-encrypted.');
}

function enrollBiometric() {
  void runAdminAction(async () => {
    // sec-05: the passphrase string never leaves persistence — the enroll flow
    // reads it internally instead of handing it back to the app surface.
    await persistence.enrollBiometrics(accountInfo.value.email);
    biometrics.enrolled.value = true;
  }, 'Biometric unlock enabled on this device.');
}

function forgetBiometric() {
  void biometrics.forget()
    .then(() => {
      biometrics.enrolled.value = false;
      adminMessage.value = 'This device can no longer unlock with biometrics.';
    })
    .catch(err => {
      adminError.value = String((err as { message?: string } | null)?.message || 'Failed to remove biometric unlock.');
    });
}

function exportDoc() {
  try {
    const vmd = persistence.exportVmd();
    const blob = new Blob([vmd], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `virgulas-${stamp}.vmd`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    adminMessage.value = 'Exported .vmd backup.';
  } catch (error) {
    adminError.value = String((error as { message?: string } | null)?.message || 'Export failed.');
  }
}

async function importDoc(e: any) {
  const file = e.target?.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    persistence.importVmd(text);
    adminMessage.value = 'Imported document. It will be re-encrypted and saved.';
  } catch (error) {
    adminError.value = String((error as { message?: string } | null)?.message || 'Import failed.');
  }
}

function handleInboxNodeNameChange(e: any) {
  inboxNodeName.value = inbox.setNodeName(e.currentTarget.value);
}

const REPO_URL = 'https://github.com/pitermarx/Virgulas';

export const OptionsModal = () => {
  if (!optionsOpen.value) return null;

  const currentMode = persistence.getMode();
  const info = accountInfo.value;
  const hasPassphrase = isEncryptedMode(currentMode);
  const isRemote = currentMode === 'remote';

  function handleThemeToggle() {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const fallback = prefersDark ? 'dark' : 'light';
    const current = document.documentElement.getAttribute('data-theme') || fallback;
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.theme.set(next);
  }

  async function handleLock() {
    optionsOpen.value = false;
    await lockNow();
  }

  async function handleChangeFile() {
    optionsOpen.value = false;
    await persistence.pickNewFile();
  }

  // After a device wipe the app lands in memory mode, whose intro fetch would
  // let the service worker recreate the app cache that the wipe just cleared.
  // Clear Cache Storage last and await it, so a purge really leaves no
  // app-owned cache behind.
  async function handleDeleteAccount() {
    const confirmed = confirm(
      accountDeletesUser.value
        ? 'Delete your account and all server data? This permanently deletes the encrypted document stored for your account and the account itself, then signs you out on this device. This cannot be undone, and your data is unrecoverable without your passphrase.'
        : 'Delete your account and all server data? This erases the encrypted document stored for your account and signs you out on this device. This cannot be undone, and your remote backup is unrecoverable without your passphrase.'
    );
    if (!confirmed) return;

    busy.value = true;
    adminError.value = '';
    adminMessage.value = '';
    try {
      await persistence.deleteAccount();
      optionsOpen.value = false;
      resetSessionState();
      // Land in memory mode with the intro doc, same as sign-out.
      await persistence.bootMemoryAfterWipe();
      document.body.setAttribute('data-main-view', 'rendered');
    } catch (err) {
      adminError.value = String((err as { message?: string } | null)?.message || 'Failed to delete the account.');
    } finally {
      busy.value = false;
    }
  }

  async function handlePurge() {
    const purgeLabel = modes[currentMode].prompt;
    if (!confirm(purgeLabel)) return;
    optionsOpen.value = false;

    if (currentMode === 'memory') {
      await loadIntroDocument();
      return;
    }

    if (currentMode === 'remote') {
      // End the remote session first — this stops polling, drops the derived key,
      // and revokes the device-local biometric seal — then clear this device.
      busy.value = true;
      try {
        await persistence.signOut();
      } catch (err) {
        adminError.value = String((err as { message?: string } | null)?.message || 'Failed to sign out.');
      } finally {
        busy.value = false;
      }
      resetSessionState();
    }

    persistence.reset();
    resetSessionState();
    // Reload into memory mode so the intro appears.
    await persistence.bootMemoryAfterWipe();
    document.body.setAttribute('data-main-view', 'rendered');
  }

  return html`
    <div class="modal-overlay" onClick=${(e: any) => { if (e.target === e.currentTarget) optionsOpen.value = false; }}>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="options-title">
        <div class="modal-header">
          <h2 class="modal-title" id="options-title">Options</h2>
          <button class="modal-close" onClick=${() => optionsOpen.value = false} aria-label="Close">×</button>
        </div>
        <div class="modal-body options-body admin-body">

          <dl class="admin-info">
            <dt>Mode</dt>
            <dd>${currentMode}${modes[currentMode].detail}</dd>

            ${currentMode === 'local' && html`
              <dt>Browser storage</dt>
              <dd data-testid="local-storage-durability">${persistence.localStorageDurability.value === 'persistent' ? 'Persistent' : 'Best-effort'}</dd>
            `}

            <dt>Email</dt>
            <dd>
              ${!isRemote
      ? html`${info.email || '—'}`
      : editingOption.value === 'email'
        ? html`<form class="admin-inline-form" onSubmit=${submitChangeEmail}>
                      <input id="admin-email" type="email" value=${newEmail.value}
                        onInput=${(e: any) => newEmail.value = e.target.value}
                        class="input-field" placeholder="New email" autocomplete="email" />
                      <button type="submit" class="btn btn-secondary" disabled=${busy.value}>Save</button>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = null}>Cancel</button>
                    </form>`
        : html`<div class="admin-inline-row">
                      <span class="admin-inline-value">${info.email || '—'}</span>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = 'email'} aria-label="Change email">Change</button>
                    </div>`}
            </dd>

            ${isRemote && html`
              <dt>Password</dt>
              <dd>
                ${editingOption.value === 'password'
        ? html`<form class="admin-inline-form" onSubmit=${submitChangePassword}>
                      <input id="admin-password" type="password" value=${newPassword.value}
                        onInput=${(e: any) => newPassword.value = e.target.value}
                        class="input-field" placeholder="New password" autocomplete="new-password" />
                      <button type="submit" class="btn btn-secondary" disabled=${busy.value}>Save</button>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = null}>Cancel</button>
                    </form>`
        : html`<div class="admin-inline-row">
                      <span class="admin-inline-value">••••••••</span>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = 'password'} aria-label="Change password">Change</button>
                    </div>`}
              </dd>
            `}

            ${hasPassphrase && html`
              <dt>Passphrase</dt>
              <dd>
                ${editingOption.value === 'passphrase'
        ? html`<form class="admin-inline-form" onSubmit=${submitChangePassphrase}>
                      <input id="admin-passphrase" type="password" value=${newPassphrase.value}
                        onInput=${(e: any) => newPassphrase.value = e.target.value}
                        class="input-field" placeholder="New passphrase" autocomplete="new-password" />
                      <button type="submit" class="btn btn-secondary" disabled=${busy.value}>Save</button>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = null}>Cancel</button>
                    </form>`
        : html`<div class="admin-inline-row">
                      <span class="admin-inline-value">••••••••</span>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = 'passphrase'} aria-label="Change passphrase">Change</button>
                    </div>`}
              </dd>
            `}

            ${hasPassphrase && html`
              <dt>Blob</dt>
              <dd class="admin-inline-value">${info.encryptedBytes} chars · AES-GCM-256 · PBKDF2 ${DEFAULT_ITERATIONS / 1000}k</dd>
            `}
          </dl>

          ${hasPassphrase && html`
            <section class="admin-section">
              <h3 class="admin-section-title">Biometric unlock</h3>
              <p class="admin-hint">
                ${biometrics.isSupported()
        ? biometrics.enrolled.value
          ? 'Unlocks with your fingerprint, face, or device PIN.'
          : 'Unlock without typing the passphrase — it is sealed on this device.'
        : 'Not supported in this browser.'}
              </p>
              ${biometrics.isSupported() && html`
                <div class="options-row">
                  ${!biometrics.enrolled.value && html`
                    <button class="btn btn-secondary" onClick=${enrollBiometric} disabled=${busy.value}>Enable on this device</button>
                  `}
                  ${biometrics.enrolled.value && html`
                    <button class="btn btn-secondary" onClick=${forgetBiometric} disabled=${busy.value}>Forget this device</button>
                  `}
                </div>
              `}
            </section>
          `}

          <section class="admin-section">
            <h3 class="admin-section-title">Quick capture</h3>
            <p class="admin-hint">
              Long-press the app icon or share text to Virgulas. Captures are stored unencrypted on
              this device and filed into your Inbox node on unlock. Automations can open
              <code class="admin-code">/?quick-add=your%20text</code>.
            </p>

            <div class="admin-inline-form">
              <span class="admin-inline-label">Bookmarklet:</span>
              <a class="btn btn-secondary" href=${bookmarkletHref} draggable="true"
                title="Click to copy, or drag onto your bookmarks bar"
                onClick=${handleBookmarkletClick}>Save to</a>
              <input id="admin-inbox-node-name" type="text" value=${inboxNodeName.value}
                onChange=${handleInboxNodeNameChange} class="input-field" maxlength="100"
                autocomplete="off" aria-label="Inbox node name" />
            </div>
            ${bookmarkletCopied.value && html`
              <p class="admin-hint">Bookmarklet copied — paste it as the URL of a new bookmark.</p>
            `}
          </section>

          <section class="admin-section">
            <h3 class="admin-section-title">Data</h3>
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${exportDoc}>Export .vmd backup</button>
              <label class="btn btn-secondary admin-file-btn">
                Import .vmd
                <input type="file" accept=".vmd,text/plain" style="display:none" onChange=${importDoc} />
              </label>
            </div>
          </section>

          <div class="options-row">
            <button class="btn btn-secondary" onClick=${handleThemeToggle}>Toggle theme</button>
          </div>

          ${currentMode === 'local' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleLock}>Lock</button>
            </div>
          `}
          ${currentMode === 'filesystem' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleChangeFile}>Change file</button>
            </div>
          `}
          ${currentMode !== 'memory' && html`
            <div class="options-row options-row-danger">
              <button class="btn btn-danger" onClick=${handlePurge} disabled=${busy.value}>
                ${modes[currentMode].action}
              </button>
            </div>
          `}

          ${isRemote && html`
            <div class="options-row">
              <button class="btn btn-danger" onClick=${handleDeleteAccount} disabled=${busy.value}>Delete account</button>
            </div>
            <p class="admin-hint">
              ${accountDeletesUser.value
                ? 'Deletes the encrypted document stored for your account and the account itself, then signs out on this device.'
                : 'Deletes the encrypted document stored for your account on the server and signs out on this device. The account itself is kept; contact support to remove it.'}
            </p>
          `}

          ${adminError.value && html`<div class="form-error" role="alert">${adminError.value}</div>`}
          ${adminMessage.value && html`<div class="form-success" role="status">${adminMessage.value}</div>`}

          <p class="admin-hint admin-footer-note">
            Your data is always encrypted before it leaves this device — the server cannot read it, and there is no way to reset a forgotten passphrase.
          </p>

          <div class="options-footer-meta">
            <span class="options-footer-version" data-app-version>${appVersion.value}</span>
            <a class="options-footer-link" href=${REPO_URL} target="_blank"
              rel="noopener noreferrer" title="Open the Virgulas source repository">See on GitHub ↗</a>
            <a class="options-footer-link" href="/privacy.html" target="_blank" rel="noopener">Privacy</a>
          </div>
        </div>
      </div>
    </div>`;
};

bindDialogFocus(optionsOpen, {
  labelId: 'options-title',
  onEscape: () => { optionsOpen.value = false; },
})
