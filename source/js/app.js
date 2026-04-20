import { html, render } from 'htm/preact';
import { signal } from '@preact/signals';
import { Outline, StatusToolbar, MainToolbar, RawEditor, DebugPanel, rawMode, optionsOpen, ConflictModal } from "./ui.js";
import persistence from './persistence.js';
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
const isBusy = signal(false);
const authUser = signal(null);

const isRemoteSessionValid = () => authMode.value === 'remote' && authScenario.value === 'remote-session-valid' && !!authUser.value;
const isLocalCreate = () => authMode.value === 'local' && !authHasLocalData.value;

async function initAuthState() {
  const bootstrap = await persistence.getAuthBootstrap();
  authMode.value = bootstrap.mode;
  authScenario.value = bootstrap.scenario;
  authHasLocalData.value = bootstrap.hasLocalData;
  authHasSupabase.value = bootstrap.hasSupabase;
  authHasFilesystem.value = bootstrap.hasFilesystem || false;
  username.value = bootstrap.lastUsername || '';
  authUser.value = bootstrap.user || null;

  // Memory mode: skip the lock screen entirely
  if (bootstrap.mode === 'memory') {
    await persistence.unlock('', { mode: 'memory' });
    document.body.setAttribute('data-main-view', 'rendered');
  }
}

setTimeout(async () => {
  await initAuthState();
  splashVisible.value = false;
}, 300);

async function switchMode(nextMode) {
  if (nextMode === authMode.value) return;

  if (nextMode === 'filesystem' && !persistence.hasFilesystem()) {
    unlockError.value = 'File System Access API is not supported in this browser.';
    return;
  }

  if (authMode.value === 'memory') {
    // Switching away from memory always discards the in-memory doc
    const confirmed = confirm('Switching storage mode will discard the current in-memory document. Continue?');
    if (!confirmed) return;
    persistence.lock();
    document.body.removeAttribute('data-main-view');
  }

  if (authMode.value === 'local' && nextMode !== 'local' && authHasLocalData.value) {
    const confirmed = confirm('Switching away from local will remove local encrypted data on this device. Continue?');
    if (!confirmed) return;
    persistence.clearLocalData();
    authHasLocalData.value = false;
    unlockMessage.value = 'Local encrypted data was cleared.';
  }

  if (authMode.value === 'remote' && nextMode !== 'remote' && authUser.value) {
    const confirmed = confirm('Switching away from remote signs you out and clears local session data. Continue?');
    if (!confirmed) return;
    await persistence.signOut();
    persistence.clearLocalData();
    authHasLocalData.value = false;
    authUser.value = null;
    unlockMessage.value = 'Signed out.';
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
  password.value = '';
  passphrase.value = '';
}

async function submitUnlock(e) {
  e.preventDefault();
  if (isBusy.value) return;
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  isBusy.value = true;
  try {
    if (authMode.value === 'filesystem') {
      await persistence.unlock('', { mode: 'filesystem' });
      document.body.setAttribute('data-main-view', 'rendered');
      return;
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
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Invalid passphrase.';
    }
  } catch (error) {
    const message = String(error?.message || 'Failed to unlock.');
    unlockError.value = message;
    canResetRemoteData.value = authMode.value === 'remote' && message.includes('Authenticated, but data could not be decrypted');
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
  } catch (error) {
    unlockError.value = String(error?.message || 'Failed to sign out.');
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
  await persistence.unlock('', { mode: 'memory' });
  document.body.setAttribute('data-main-view', 'rendered');
}

const LockScreen = () => {
  const mode = authMode.value;
  const isFilesystem = mode === 'filesystem';
  const isRemote = mode === 'remote';
  const isLocal = mode === 'local';
  const isSessionValid = isRemoteSessionValid();

  const unlockDisabled = isBusy.value
    || (!isFilesystem && !passphrase.value.trim())
    || (isRemote && !isSessionValid && (!username.value.trim() || !password.value));

  // Mode descriptions
  const modeDescriptions = {
    local: isLocalCreate() ? 'Encrypted local storage — create a passphrase to get started.' : 'Encrypted local storage — enter your passphrase to unlock.',
    remote: isSessionValid
      ? `Encrypted sync — signed in as ${authUser.value?.email || ''}. Enter your passphrase to decrypt.`
      : 'Encrypted sync via Supabase — sign in then enter your passphrase.',
    filesystem: 'Open a local file — no encryption, no passphrase needed.'
  };

  return html`
    <div class="auth-card">
      <h1 class="auth-title">Unlock Virgulas</h1>

      <div class="auth-mode-switch" role="group" aria-label="Storage mode">
        <button type="button" class=${`auth-mode-btn ${isLocal ? 'is-active' : ''}`}
          onClick=${() => switchMode('local')}>
          Local
        </button>
        <button type="button" class=${`auth-mode-btn ${isRemote ? 'is-active' : ''}`}
          onClick=${() => switchMode('remote')}>
          Remote
        </button>
        <button type="button" class=${`auth-mode-btn ${isFilesystem ? 'is-active' : ''}`}
          onClick=${() => switchMode('filesystem')}>
          File
        </button>
      </div>

      <p class="auth-subtitle">${modeDescriptions[mode]}</p>

      ${isRemote && !isSessionValid && html`
        <div class="input-group">
          <label for="auth-username" class="input-label">Email</label>
          <input value=${username.value} onInput=${(e) => username.value = e.target.value}
            id="auth-username" type="text" placeholder="you@example.com" class="input-field" autocomplete="email" />
        </div>
        <div class="input-group">
          <label for="auth-password" class="input-label">Account password</label>
          <input value=${password.value} onInput=${(e) => password.value = e.target.value}
            id="auth-password" type="password" placeholder="Account password" class="input-field" autocomplete="current-password" />
        </div>
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
          <div class="input-group">
            <label for="auth-passphrase" class="input-label">
              ${isLocalCreate() ? 'Create a passphrase' : 'Encryption passphrase'}
            </label>
            <input value=${passphrase.value} onInput=${(e) => passphrase.value = e.target.value}
              id="auth-passphrase" type="password"
              placeholder=${isLocalCreate() ? 'Choose a passphrase' : 'Enter your passphrase'}
              class="input-field" autocomplete=${isLocalCreate() ? 'new-password' : 'current-password'} />
          </div>
        `}
        ${unlockMessage.value && html`<div class="form-success">${unlockMessage.value}</div>`}
        ${unlockError.value && html`<div class="form-error">${unlockError.value}</div>`}
        ${canResetRemoteData.value && html`
          <div class="auth-secondary-actions">
            <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
              onClick=${submitResetRemoteData}>Reset Remote Data With New Passphrase</button>
          </div>
        `}
        <button type="submit" class="lock-submit-btn" disabled=${unlockDisabled} aria-label="Unlock" title="Unlock">
          ${isBusy.value ? '...' : isFilesystem ? '📂' : '🔒'}
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

      <div class="auth-memory-skip">
        <button type="button" class="auth-memory-link" onClick=${continueInMemory} disabled=${isBusy.value}>
          Skip — continue in memory
        </button>
      </div>
    </div>
  `;
};

const REPO_URL = 'https://github.com/pnunes30/Virgulas';

const OptionsModal = () => {
  if (!optionsOpen.value) return null;

  const currentMode = persistence.getMode();

  function handleThemeToggle() {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const fallback = prefersDark ? 'dark' : 'light';
    const current = document.documentElement.getAttribute('data-theme') || fallback;
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.theme.set(next);
  }

  function handleLock() {
    optionsOpen.value = false;
    persistence.lock();
  }

  async function handleSignOut() {
    optionsOpen.value = false;
    isBusy.value = true;
    try {
      await persistence.signOut();
      authUser.value = null;
      authScenario.value = 'remote-session-expired';
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
    persistence.lock();
    document.body.removeAttribute('data-main-view');
    authMode.value = 'local';
    authScenario.value = authHasLocalData.value ? 'local-present-no-session' : 'empty-local';
    unlockError.value = '';
    unlockMessage.value = '';
  }

  async function handleChangeFile() {
    optionsOpen.value = false;
    await persistence.pickNewFile();
  }

  async function handlePurge() {
    const purgeLabel = currentMode === 'remote'
      ? 'Clear browser session and sign out? Your remote data on the server is unaffected.'
      : currentMode === 'filesystem'
        ? 'Clear the remembered file handle and local session? Your .vmd file on disk is unaffected.'
        : 'Delete locally encrypted data? This cannot be undone.';
    if (!confirm(purgeLabel)) return;
    optionsOpen.value = false;
    persistence.reset();
    authHasLocalData.value = false;
    authUser.value = null;
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
          <div class="options-row options-row-danger">
            <button class="btn btn-danger" onClick=${handlePurge}>
              ${currentMode === 'remote' ? 'Sign out & clear session' : currentMode === 'filesystem' ? 'Clear file session' : 'Delete local data'}
            </button>
          </div>
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

  if (persistence.isLocked()) {
    document.body.removeAttribute('data-main-view');
    return html`<${LockScreen} />`;
  }

  document.body.setAttribute('data-main-view', 'rendered');
  return html`<div class="main-view">
    ${rawMode.value
      ? html`<${RawEditor} />`
      : html`<div class="main-content">
          <${MainToolbar} />
          <${Outline} />
          <${DebugPanel} />
        </div>`
    }
    <${StatusToolbar} />
    <${OptionsModal} />
    <${ConflictModal} />
  </div>`;
};

render(html`<${Splash} />`, document.getElementById('app'));
