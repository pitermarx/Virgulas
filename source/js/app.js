import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { state } from './state.js';
import { storage } from './storage.js';
import { AppSync } from './sync.js';
import { AppCrypto } from './crypto.js';
import { UnifiedLockView, RawView, MainView } from './view.js';
import { dispatch } from './update.js';

// Expose for testing and global access
window.App = window.App || {};
window.App.crypto = AppCrypto;
window.App.storage = storage;
window.App.state = state;
window.App.sync = AppSync;
window.App.dispatch = dispatch; // Will be overwritten by View but good default

// Check initial state
const initApp = async () => {
  console.log('initApp called');
  storage.init();
  state.quickUnlockFallbackVisible.value = false;
  state.authRemotePayload.value = null;
  state.authHasLocalData.value = storage.hasRaw('vmd_data');
  state.authLastUsername.value = localStorage.getItem('vmd_last_username') || '';

  try {
    state.quickUnlockSupported.value = await AppCrypto.isQuickUnlockSupported();
  } catch (err) {
    console.warn('Quick unlock support detection failed', err);
    state.quickUnlockSupported.value = false;
  }

  const hasQuickUnlockData = storage.hasRaw(AppCrypto.PRF_WRAPPED_KEY) && storage.hasRaw(AppCrypto.PRF_ID_KEY);
  if (hasQuickUnlockData && AppCrypto.isQuickUnlockLocallyDisabled()) {
    state.quickUnlockFallbackVisible.value = true;
  }

  // Init theme
  const storedTheme = localStorage.getItem('vmd_theme');
  if (storedTheme) {
    state.theme.value = storedTheme;
    document.documentElement.setAttribute('data-theme', storedTheme);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    state.theme.value = 'dark';
  }

  const tryQuickUnlockWithLocalData = async () => {
    if (!state.authHasLocalData.value || !hasQuickUnlockData || !state.quickUnlockSupported.value) {
      return false;
    }

    try {
      const passphrase = await AppCrypto.quickUnlockPassphrase(
        storage.getRaw(AppCrypto.PRF_WRAPPED_KEY),
        storage.getRaw(AppCrypto.PRF_ID_KEY),
        { timeoutMs: AppCrypto.QUICK_UNLOCK_AUTO_TIMEOUT_MS }
      );
      const key = await AppCrypto.deriveKey(passphrase, storage.getSalt());
      const doc = await storage.get('vmd_data', key);

      if (!doc) {
        AppCrypto.markQuickUnlockUnsupported();
        state.quickUnlockSupported.value = false;
        state.quickUnlockFallbackVisible.value = true;
        return false;
      }

      state.key.value = key;
      state.doc.value = doc;
      state.quickUnlockOfferVisible.value = false;
      state.quickUnlockPassphrase.value = null;
      state.quickUnlockFallbackVisible.value = false;
      state.status.value = 'ready';
      return true;
    } catch (err) {
      console.warn('Quick unlock failed, falling back to passphrase', err);
      AppCrypto.markQuickUnlockUnsupported();
      state.quickUnlockSupported.value = false;
      state.quickUnlockFallbackVisible.value = true;
      return false;
    }
  };

  const classifyAndSetAuthState = async () => {
    let user = null;
    let remote = null;

    AppSync.init();

    try {
      user = await AppSync.refreshSession();
    } catch (err) {
      console.warn('Failed to refresh sync session', err);
    }

    if (user?.email) {
      state.authLastUsername.value = user.email;
      localStorage.setItem('vmd_last_username', user.email);
    }

    if (user) {
      try {
        remote = await AppSync.download();
      } catch (err) {
        console.warn('Failed to fetch remote encrypted payload', err);
      }
    }

    if (user && remote?.salt && remote?.data) {
      storage.setSalt(remote.salt);
      state.authMode.value = 'remote';
      state.authScenario.value = 'remote-session-valid';
      state.authRemotePayload.value = remote;
      state.status.value = 'unlock';
      return;
    }

    if (state.authHasLocalData.value) {
      state.authMode.value = 'local';
      state.authScenario.value = 'local-present-no-session';
      state.status.value = 'unlock';
      return;
    }

    if (!user && state.authLastUsername.value) {
      state.authMode.value = 'remote';
      state.authScenario.value = 'remote-session-expired';
      state.status.value = 'unlock';
      return;
    }

    state.authMode.value = 'local';
    state.authScenario.value = 'empty-local';
    state.status.value = 'setup';
  };

  if (window.supabase) {
    await classifyAndSetAuthState();
    if (state.status.value !== 'ready' && state.authHasLocalData.value) {
      await tryQuickUnlockWithLocalData();
    }
  } else {
    state.syncConfigured.value = false;

    if (state.authHasLocalData.value) {
      state.authMode.value = 'local';
      state.authScenario.value = 'local-present-no-session';
      state.status.value = 'unlock';
      await tryQuickUnlockWithLocalData();
    } else if (state.authLastUsername.value) {
      state.authMode.value = 'remote';
      state.authScenario.value = 'remote-session-expired';
      state.status.value = 'unlock';
    } else {
      state.authMode.value = 'local';
      state.authScenario.value = 'empty-local';
      state.status.value = 'setup';
    }

    window.addEventListener('load', async () => {
      if (window.supabase) {
        await classifyAndSetAuthState();
        if (state.status.value !== 'ready' && state.authHasLocalData.value) {
          await tryQuickUnlockWithLocalData();
        }
      }
    }, { once: true });
  }

  // Hide splash screen
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 700);
  }
};

const App = () => {
  useEffect(() => initApp(), []);
  const viewMode = state.viewMode.value;

  switch (state.status.value) {
    case 'loading':
      return null;
    case 'setup':
    case 'unlock':
      return html`<${UnifiedLockView} />`;
    case 'ready':
      return viewMode === 'raw' ? html`<${RawView} />` : html`<${MainView} />`;
    default:
      return html`<div>Unknown state</div>`;
  }
};

render(html`<${App} />`, document.getElementById('app'));
