import { html, render } from 'htm/preact';
import { signal } from '@preact/signals';
import { Outline, StatusToolbar, MainToolbar, RawEditor, DebugPanel, rawMode, optionsOpen, ConflictModal } from "./ui.js";
import persistence from './persistence.js';
import outline from './outline.js';
import { appVersion } from './devtools.js';
import { store } from './utils.js';

const splashVisible = signal(true);

// B4: Restore persisted theme preference on load
const savedTheme = store.theme.get();
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme);
}

const authMode = signal('local');
const authScenario = signal('empty-local');
const authHasLocalData = signal(false);
const authHasSupabase = signal(false);
const authHasFilesystem = signal(false);
const username = signal('');
const password = signal('');
const passphrase = signal('');
const unlockError = signal('');
const unlockMessage = signal('');
const canResetRemoteData = signal(false);
const canResetLocalData = signal(false);
const isBusy = signal(false);
const authUser = signal(null);
const authStep = signal('unlock');
const quickUnlockSupported = signal(false);
const quickUnlockSavedForMode = signal(false);
const savePassphraseOnDevice = signal(false);

const isRemoteSessionValid = () => authMode.value === 'remote' && authScenario.value === 'remote-session-valid' && !!authUser.value;
const isLocalCreate = () => authMode.value === 'local' && !authHasLocalData.value;

function getQuickUnlockAccountIdForMode(mode = authMode.value) {
  if (mode !== 'remote') return '';
  return String(authUser.value?.email || username.value || persistence.getLastUsername() || '').trim().toLowerCase();
}

function refreshQuickUnlockState() {
  quickUnlockSupported.value = persistence.isQuickUnlockSupported();
  const mode = authMode.value;
  if (!quickUnlockSupported.value || (mode !== 'local' && mode !== 'remote')) {
    quickUnlockSavedForMode.value = false;
    savePassphraseOnDevice.value = false;
    return;
  }

  quickUnlockSavedForMode.value = persistence.hasSavedQuickUnlock({
    mode,
    accountId: getQuickUnlockAccountIdForMode(mode)
  });

  if (quickUnlockSavedForMode.value) {
    savePassphraseOnDevice.value = false;
  }
}

let stagedMemoryDocJson = null;
let cachedIntroText = null;

async function getIntroText() {
  if (cachedIntroText !== null) return cachedIntroText;
  try {
    const resp = await fetch('/intro.vmd');
    cachedIntroText = resp.ok ? await resp.text() : '';
  } catch {
    cachedIntroText = '';
  }
  return cachedIntroText;
}

async function loadLockedBackgroundIntro() {
  const introText = await getIntroText();
  outline.reset();
  if (introText && introText.trim()) {
    outline.setRootVMD(introText);
  } else {
    outline.addChild('root', { text: '' });
  }
}

async function initAuthState() {
  const bootstrap = await persistence.getAuthBootstrap();
  authMode.value = bootstrap.mode;
  authScenario.value = bootstrap.scenario;
  authHasLocalData.value = bootstrap.hasLocalData;
  authHasSupabase.value = bootstrap.hasSupabase;
  authHasFilesystem.value = bootstrap.hasFilesystem || false;
  username.value = bootstrap.lastUsername || '';
  authUser.value = bootstrap.user || null;
  quickUnlockSupported.value = !!bootstrap.quickUnlockSupported;
  refreshQuickUnlockState();

  // Memory mode: skip the lock screen entirely
  if (bootstrap.mode === 'memory') {
    await persistence.unlock('', { mode: 'memory' });
    document.body.setAttribute('data-main-view', 'rendered');
    return;
  }

  if (quickUnlockSupported.value) {
    const quickUnlockResult = await persistence.tryQuickUnlockStartup({
      mode: bootstrap.mode,
      scenario: bootstrap.scenario,
      user: bootstrap.user || null,
      lastUsername: bootstrap.lastUsername || ''
    });
    if (quickUnlockResult.success) {
      stagedMemoryDocJson = null;
      refreshQuickUnlockState();
      document.body.setAttribute('data-main-view', 'rendered');
      return;
    }
    if (quickUnlockResult.attempted && quickUnlockResult.message && !quickUnlockResult.cancelled) {
      unlockMessage.value = quickUnlockResult.message;
    }
  }

  if (persistence.isLocked()) {
    await loadLockedBackgroundIntro();
  }
}

setTimeout(async () => {
  await initAuthState();
  splashVisible.value = false;
}, 300);

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
  authStep.value = 'choose-mode';
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  passphrase.value = '';
  password.value = '';
  savePassphraseOnDevice.value = false;
  refreshQuickUnlockState();
}

function pickMode(nextMode) {
  if (nextMode === 'filesystem' && !persistence.hasFilesystem()) {
    unlockError.value = 'File System Access API is not supported in this browser.';
    return;
  }
  authMode.value = nextMode;
  authScenario.value = nextMode === 'local'
    ? (authHasLocalData.value ? 'local-present-no-session' : 'empty-local')
    : nextMode === 'filesystem'
      ? 'filesystem-ready'
      : 'remote-session-expired';
  persistence.setPreferredMode(nextMode);
  unlockError.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  passphrase.value = '';
  password.value = '';
  savePassphraseOnDevice.value = false;
  authStep.value = 'unlock';
  refreshQuickUnlockState();
}

async function submitUnlock(e) {
  e.preventDefault();
  if (isBusy.value) return;
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  isBusy.value = true;
  try {
    if (authMode.value === 'filesystem') {
      await persistence.unlock('', { mode: 'filesystem' });
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
      return;
    }

    const canUseSavedRemotePassphrase = authMode.value === 'remote'
      && !isRemoteSessionValid()
      && !passphrase.value.trim()
      && !!username.value.trim()
      && !!password.value
      && quickUnlockSupported.value
      && persistence.hasSavedQuickUnlock({ mode: 'remote', accountId: username.value.trim() });

    if (canUseSavedRemotePassphrase) {
      const quickUnlockResult = await persistence.unlockWithSavedQuickUnlock({
        mode: 'remote',
        accountId: username.value.trim(),
        username: username.value,
        password: password.value,
        trustSession: false
      });

      if (quickUnlockResult.success) {
        authUser.value = await persistence.getUser();
        stagedMemoryDocJson = null;
        refreshQuickUnlockState();
        document.body.setAttribute('data-main-view', 'rendered');
        return;
      }

      if (quickUnlockResult.attempted) {
        unlockError.value = quickUnlockResult.message || 'Saved passphrase could not be used. Enter passphrase manually.';
        refreshQuickUnlockState();
        return;
      }
    }

    if (!passphrase.value.trim()) {
      unlockError.value = 'Passphrase cannot be empty.';
      return;
    }

    if (authMode.value === 'remote' && !authHasSupabase.value) {
      unlockError.value = 'Remote mode is unavailable because sync is not configured.';
      return;
    }

    const success = await persistence.unlock(passphrase.value, {
      mode: authMode.value,
      username: username.value,
      password: password.value,
      trustSession: isRemoteSessionValid()
    });
    if (success) {
      if (authMode.value === 'remote') {
        authUser.value = await persistence.getUser();
      }
      if (savePassphraseOnDevice.value
        && quickUnlockSupported.value
        && (authMode.value === 'local' || authMode.value === 'remote')) {
        try {
          await persistence.saveQuickUnlock({
            mode: authMode.value,
            accountId: getQuickUnlockAccountIdForMode(authMode.value),
            passphrase: passphrase.value.trim()
          });
          savePassphraseOnDevice.value = false;
        } catch (saveError) {
          if (String(saveError?.code || '') !== 'cancelled') {
            console.error('[QuickUnlock] Failed to save passphrase:', saveError);
          }
        }
      }
      stagedMemoryDocJson = null;
      refreshQuickUnlockState();
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Invalid passphrase.';
      canResetLocalData.value = authMode.value === 'local' && authHasLocalData.value;
      refreshQuickUnlockState();
    }
  } catch (error) {
    const message = String(error?.message || 'Failed to unlock.');
    unlockError.value = message;
    canResetRemoteData.value = authMode.value === 'remote' && message.includes('Authenticated, but data could not be decrypted');
    refreshQuickUnlockState();
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
    if (!result?.user) {
      unlockMessage.value = 'Sign-up submitted. Confirm your email if confirmation is enabled.';
    }
  } catch (error) {
    unlockError.value = String(error?.message || 'Failed to sign up.');
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
    authScenario.value = 'remote-session-expired';
    authMode.value = 'remote';
    savePassphraseOnDevice.value = false;
    refreshQuickUnlockState();
    await loadLockedBackgroundIntro();
  } catch (error) {
    unlockError.value = String(error?.message || 'Failed to sign out.');
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
    canResetLocalData.value = false;
    const success = await persistence.unlock(passphrase.value, { mode: 'local' });
    if (success) {
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Failed to create new local data.';
    }
  } catch (error) {
    unlockError.value = String(error?.message || 'Failed to reset local data.');
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
    canResetRemoteData.value = false;
    document.body.setAttribute('data-main-view', 'rendered');
  } catch (error) {
    unlockError.value = String(error?.message || 'Failed to reset remote data.');
  } finally {
    isBusy.value = false;
  }
}

async function continueInMemory() {
  const staged = stagedMemoryDocJson;
  stagedMemoryDocJson = null;
  await persistence.unlock('', { mode: 'memory' });
  if (staged) {
    outline.deserialize(staged);
  }
  document.body.setAttribute('data-main-view', 'rendered');
}

function openSecureStorageSetup() {
  stagedMemoryDocJson = outline.serialize();
  persistence.lock();
  authMode.value = 'local';
  authScenario.value = authHasLocalData.value ? 'local-present-no-session' : 'empty-local';
  authStep.value = 'unlock';
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  password.value = '';
  passphrase.value = '';
  savePassphraseOnDevice.value = false;
  refreshQuickUnlockState();
  document.body.removeAttribute('data-main-view');
}

const LockScreen = () => {
  const step = authStep.value;
  const mode = authMode.value;
  const isFilesystem = mode === 'filesystem';
  const isRemote = mode === 'remote';
  const isLocal = mode === 'local';
  const isSessionValid = isRemoteSessionValid();
  const canUseSavedRemotePassphrase = isRemote
    && !isSessionValid
    && quickUnlockSupported.value
    && quickUnlockSavedForMode.value
    && !!username.value.trim()
    && !!password.value;

  const showQuickUnlockOptIn = quickUnlockSupported.value
    && (isLocal || isRemote)
    && !isFilesystem
    && !quickUnlockSavedForMode.value;

  const unlockDisabled = isBusy.value
    || (!isFilesystem && !passphrase.value.trim() && !canUseSavedRemotePassphrase)
    || (isRemote && !isSessionValid && (!username.value.trim() || !password.value));

  const modeLabel = isLocal ? 'Local' : isRemote ? 'Remote' : 'File';

  return html`
    <div class="bottom-sheet" data-auth-mode=${mode} role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-content">

        ${step === 'choose-mode' && html`
          <h1 class="auth-title" id="auth-title">Choose Storage</h1>
          <div class="auth-mode-switch" role="group" aria-label="Storage mode">
            <button type="button" class=${'auth-mode-btn' + (isLocal ? ' is-active' : '')}
              onClick=${() => pickMode('local')}>Local</button>
            <button type="button" class=${'auth-mode-btn' + (isRemote ? ' is-active' : '')}
              onClick=${() => pickMode('remote')}>Remote</button>
            <button type="button" class=${'auth-mode-btn' + (isFilesystem ? ' is-active' : '')}
              onClick=${() => pickMode('filesystem')}>File</button>
          </div>
          ${unlockError.value && html`<div class="form-error">${unlockError.value}</div>`}
          <div class="auth-memory-skip">
            <button type="button" class="auth-memory-link" onClick=${continueInMemory} disabled=${isBusy.value}>
              Skip — continue in memory
            </button>
          </div>
        `}

        ${step === 'unlock' && html`
          <h1 class="auth-title" id="auth-title">Unlock Virgulas</h1>
          <div class="status-text">
            ${isLocal && (isLocalCreate() ? 'Secure Your Workspace' : 'Encrypted Local Storage')}
            ${isRemote && (isSessionValid ? 'Remote — ' + (authUser.value?.email || '') : 'Remote — sign in')}
            ${isFilesystem && 'File'}
          </div>

          ${isRemote && !isSessionValid && html`
            <div class="input-group">
              <label for="auth-username" class="input-label">Email</label>
              <input value=${username.value} onInput=${(e) => { username.value = e.target.value; refreshQuickUnlockState(); }}
                id="auth-username" type="text" placeholder="you@example.com" class="input-field" autocomplete="email" />
            </div>
            <div class="input-group">
              <label for="auth-password" class="input-label">Account password</label>
              <input value=${password.value} onInput=${(e) => password.value = e.target.value}
                id="auth-password" type="password" placeholder="Account password" class="input-field" autocomplete="current-password" />
            </div>
            ${quickUnlockSupported.value && quickUnlockSavedForMode.value && html`
              <div class="form-success">Saved passphrase is available for this account on this device.</div>
            `}
          `}

          ${isRemote && isSessionValid && html`
            <div class="auth-secondary-actions">
              <button type="button" class="toolbar-btn" disabled=${isBusy.value} onClick=${submitSignOut}>
                ${isBusy.value ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
          `}

          <form onSubmit=${submitUnlock}>
            ${!isFilesystem && html`
              <label for="auth-passphrase" class="visually-hidden">
                ${isLocalCreate() ? 'Create a passphrase' : 'Encryption passphrase'}
              </label>
              <input
                value=${passphrase.value}
                onInput=${(e) => passphrase.value = e.target.value}
                id="auth-passphrase"
                type="password"
                placeholder=${isLocalCreate() ? 'Create passphrase' : 'Passphrase'}
                class="huge-input"
                autocomplete=${isLocalCreate() ? 'new-password' : 'current-password'}
              />
            `}
            ${showQuickUnlockOptIn && html`
              <div class="auth-secondary-actions">
                <label class="input-label">
                  <input
                    type="checkbox"
                    checked=${savePassphraseOnDevice.value}
                    onChange=${(e) => savePassphraseOnDevice.value = !!e.target.checked}
                    disabled=${isBusy.value}
                  />
                  Save passphrase on this device
                </label>
              </div>
            `}
            ${unlockMessage.value && html`<div class="form-success">${unlockMessage.value}</div>`}
            ${unlockError.value && html`<div class="form-error">${unlockError.value}</div>`}
            ${canResetLocalData.value && html`
              <div class="auth-secondary-actions">
                <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
                  onClick=${submitResetLocalData}>Reset Local Data With New Passphrase</button>
              </div>
            `}
            ${canResetRemoteData.value && html`
              <div class="auth-secondary-actions">
                <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
                  onClick=${submitResetRemoteData}>Reset Remote Data With New Passphrase</button>
              </div>
            `}
            <button type="submit" class="lock-submit-btn" disabled=${unlockDisabled} aria-label="Unlock" title="Unlock">
              ${isBusy.value ? '...' : isFilesystem ? 'Open File' : 'Unlock'}
            </button>
          </form>

          ${isRemote && !isSessionValid && html`
            <div class="auth-secondary-actions">
              <button type="button" class="toolbar-btn" disabled=${isBusy.value || !username.value.trim() || !password.value}
                onClick=${submitSignUp}>
                ${isBusy.value ? '...' : 'Sign up'}
              </button>
            </div>
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

const SecureStoragePrompt = () => {
  if (persistence.isLocked() || !persistence.isMemory()) return null;

  return html`
    <button type="button" class="app-node" onClick=${openSecureStorageSetup}>
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

const REPO_URL = 'https://github.com/pitermarx/Virgulas';

const OptionsModal = () => {
  if (!optionsOpen.value) return null;

  const currentMode = persistence.getMode();
  const quickUnlockSavedSignal = quickUnlockSavedForMode.value;
  const quickUnlockModeEligible = currentMode === 'local' || currentMode === 'remote';
  const quickUnlockAvailable = quickUnlockModeEligible && persistence.isQuickUnlockSupported();
  const quickUnlockAccountId = currentMode === 'remote' ? String(authUser.value?.email || '').trim().toLowerCase() : '';
  const quickUnlockSaved = quickUnlockAvailable
    && (quickUnlockSavedSignal || persistence.hasSavedQuickUnlock({
      mode: currentMode,
      accountId: quickUnlockAccountId
    }));

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
    persistence.lock();
    authMode.value = 'local';
    authScenario.value = authHasLocalData.value ? 'local-present-no-session' : 'empty-local';
    authStep.value = 'unlock';
    savePassphraseOnDevice.value = false;
    refreshQuickUnlockState();
    await loadLockedBackgroundIntro();
  }

  async function handleSignOut() {
    optionsOpen.value = false;
    isBusy.value = true;
    try {
      await persistence.signOut();
      authUser.value = null;
      authScenario.value = 'remote-session-expired';
      savePassphraseOnDevice.value = false;
      refreshQuickUnlockState();
      await loadLockedBackgroundIntro();
    } catch (err) {
      unlockError.value = String(err?.message || 'Failed to sign out.');
    } finally {
      isBusy.value = false;
    }
  }

  async function handleUpgradeStorage() {
    optionsOpen.value = false;
    const confirmed = confirm('Switching to a persistent storage mode will discard the current in-memory document. Continue?');
    if (!confirmed) return;
    stagedMemoryDocJson = null;
    persistence.lock();
    await loadLockedBackgroundIntro();
    authMode.value = 'local';
    authScenario.value = authHasLocalData.value ? 'local-present-no-session' : 'empty-local';
    authStep.value = 'unlock';
    unlockError.value = '';
    unlockMessage.value = '';
    savePassphraseOnDevice.value = false;
    refreshQuickUnlockState();
  }

  async function handleChangeFile() {
    optionsOpen.value = false;
    await persistence.pickNewFile();
  }

  async function handleEnableQuickUnlock() {
    const activePassphrase = persistence.getPassphrase();
    if (!activePassphrase) {
      alert('Unlock with a passphrase before enabling quick unlock.');
      return;
    }

    isBusy.value = true;
    try {
      await persistence.saveQuickUnlock({
        mode: currentMode,
        accountId: quickUnlockAccountId,
        passphrase: activePassphrase
      });
      refreshQuickUnlockState();
    } catch (error) {
      if (String(error?.code || '') !== 'cancelled') {
        alert(String(error?.message || 'Could not enable quick unlock.'));
      }
    } finally {
      isBusy.value = false;
    }
  }

  async function handleRemoveQuickUnlock() {
    const confirmed = confirm('Remove the saved passphrase from this device?');
    if (!confirmed) return;
    persistence.removeQuickUnlock({ mode: currentMode, accountId: quickUnlockAccountId });
    refreshQuickUnlockState();
  }

  async function handleReplaceQuickUnlock() {
    const activePassphrase = persistence.getPassphrase();
    if (!activePassphrase) {
      alert('Unlock with a passphrase before replacing quick unlock.');
      return;
    }

    isBusy.value = true;
    try {
      await persistence.saveQuickUnlock({
        mode: currentMode,
        accountId: quickUnlockAccountId,
        passphrase: activePassphrase
      });
      refreshQuickUnlockState();
    } catch (error) {
      if (String(error?.code || '') !== 'cancelled') {
        alert(String(error?.message || 'Could not replace quick unlock.'));
      }
    } finally {
      isBusy.value = false;
    }
  }

  async function handlePurge() {
    const purgeLabel = currentMode === 'remote'
      ? 'Clear browser session and sign out? Your remote data on the server is unaffected.'
      : currentMode === 'filesystem'
        ? 'Clear the remembered file handle and local session? Your .vmd file on disk is unaffected.'
        : 'Delete locally encrypted data? This cannot be undone.';
    if (!confirm(purgeLabel)) return;
    optionsOpen.value = false;

    if (currentMode === 'memory') {
      const introText = await getIntroText();
      outline.reset();
      if (introText && introText.trim()) {
        outline.setRootVMD(introText);
      } else {
        outline.addChild('root', { text: '' });
      }
      return;
    }

    persistence.reset();
    authHasLocalData.value = false;
    authUser.value = null;
    savePassphraseOnDevice.value = false;
    refreshQuickUnlockState();
    // Reload into memory mode so the intro appears
    await persistence.unlock('', { mode: 'memory' });
    document.body.setAttribute('data-main-view', 'rendered');
  }

  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const themeAttr = document.documentElement.getAttribute('data-theme') || (prefersDark ? 'dark' : 'light');
  const themeLabel = themeAttr === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme';

  return html`
    <div class="modal-overlay" onClick=${e => { if (e.target === e.currentTarget) optionsOpen.value = false; }}>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="options-title">
        <div class="modal-header">
          <h2 class="modal-title" id="options-title">Options</h2>
          <button class="modal-close" onClick=${() => optionsOpen.value = false} aria-label="Close">×</button>
        </div>
        <div class="modal-body options-body">
          <div class="options-row">
            <button class="btn btn-secondary" onClick=${handleThemeToggle}>${themeLabel}</button>
          </div>
          <div class="options-row">
            <a href=${REPO_URL} target="_blank" rel="noopener noreferrer" class="btn btn-secondary">Source repository ↗</a>
          </div>
          ${currentMode === 'memory' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleUpgradeStorage}>Upgrade storage…</button>
            </div>
          `}
          ${currentMode === 'remote' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleSignOut} disabled=${isBusy.value}>Sign out</button>
            </div>
          `}
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
          ${quickUnlockAvailable && html`
            ${quickUnlockSaved
              ? html`
                <div class="options-row">
                  <div class="options-footer-meta">Quick unlock enabled on this device</div>
                </div>
                <div class="options-row">
                  <button class="btn btn-secondary" onClick=${handleReplaceQuickUnlock} disabled=${isBusy.value}>Replace saved passphrase</button>
                </div>
                <div class="options-row">
                  <button class="btn btn-secondary" onClick=${handleRemoveQuickUnlock} disabled=${isBusy.value}>Remove saved passphrase</button>
                </div>
              `
              : html`
                <div class="options-row">
                  <button class="btn btn-secondary" onClick=${handleEnableQuickUnlock} disabled=${isBusy.value}>Enable quick unlock on this device</button>
                </div>
              `}
          `}
          <div class="options-row options-row-danger">
            <button class="btn btn-danger" onClick=${handlePurge}>
              ${currentMode === 'remote' ? 'Sign out & clear session' : currentMode === 'filesystem' ? 'Clear file session' : 'Delete local data'}
            </button>
          </div>
          <div class="options-footer-meta">Version <span class="options-footer-version" data-app-version>${appVersion.value}</span></div>
        </div>
      </div>
    </div>`;
};

const Splash = () => {
  if (splashVisible.value) return html`
    <div id="splash">
      <div class="logo">Virgulas</div>
      <div class="tagline">Local-first browser outliner</div>
    </div>`;

  const isLocked = persistence.isLocked();

  if (isLocked) {
    document.body.removeAttribute('data-main-view');
  } else {
    document.body.setAttribute('data-main-view', 'rendered');
  }

  return html`
    <div class="app-shell">
      <div class=${`main-view ${isLocked ? 'is-locked' : ''}`}>
        ${rawMode.value && !isLocked
          ? html`<${RawEditor} />`
          : html`<div class="main-content">
              <${MainToolbar} />
              <${SecureStoragePrompt} />
              <${Outline} />
              <${DebugPanel} />
            </div>`
        }
        <${StatusToolbar} />
        ${!isLocked && html`<${OptionsModal} />`}
        ${!isLocked && html`<${ConflictModal} />`}
      </div>
      ${isLocked && html`<${LockScreen} />`}
    </div>
  `;
};

render(html`<${Splash} />`, document.getElementById('app'));
