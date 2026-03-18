import { h, render } from 'preact';
import { useEffect } from 'preact/hooks';
import { state } from './state.js';
import { storage } from './storage.js';
import { AppSync } from './sync.js';
import { AppCrypto } from './crypto.js';
import { SetupView, UnlockView, RawView, MainView } from './view.js';
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
  // storage.init() is already called in index.html or should be called here
  storage.init();
  state.quickUnlockFallbackVisible.value = false;

  try {
    state.quickUnlockSupported.value = await AppCrypto.isQuickUnlockSupported();
  } catch (err) {
    console.warn('Quick unlock support detection failed', err);
    state.quickUnlockSupported.value = false;
  }

  if (storage.hasRaw('vmd_data')) {
    const hasQuickUnlockData = storage.hasRaw(AppCrypto.PRF_WRAPPED_KEY) && storage.hasRaw(AppCrypto.PRF_ID_KEY);
    if (hasQuickUnlockData && AppCrypto.isQuickUnlockLocallyDisabled()) {
      state.quickUnlockFallbackVisible.value = true;
    }

    if (state.quickUnlockSupported.value && hasQuickUnlockData) {
      try {
        const passphrase = await AppCrypto.quickUnlockPassphrase(
          storage.getRaw(AppCrypto.PRF_WRAPPED_KEY),
          storage.getRaw(AppCrypto.PRF_ID_KEY),
          { timeoutMs: AppCrypto.QUICK_UNLOCK_AUTO_TIMEOUT_MS }
        );
        const key = await AppCrypto.deriveKey(passphrase, storage.getSalt());
        const doc = await storage.get('vmd_data', key);

        if (doc) {
          state.key.value = key;
          state.doc.value = doc;
          state.quickUnlockOfferVisible.value = false;
          state.quickUnlockPassphrase.value = null;
          state.quickUnlockFallbackVisible.value = false;
          state.status.value = 'ready';
        } else {
          AppCrypto.markQuickUnlockUnsupported('unlock_doc_unavailable');
          state.quickUnlockSupported.value = false;
          state.quickUnlockFallbackVisible.value = true;
          state.status.value = 'unlock';
        }
      } catch (err) {
        console.warn('Quick unlock failed, falling back to passphrase', err);
        AppCrypto.markQuickUnlockUnsupported('unlock_failed');
        state.quickUnlockSupported.value = false;
        state.quickUnlockFallbackVisible.value = true;
        state.status.value = 'unlock';
      }
    } else {
      console.log('Setting status to unlock');
      state.status.value = 'unlock';
    }
  } else {
    console.log('Setting status to setup');
    state.status.value = 'setup';
  }

  // Init theme
  const storedTheme = localStorage.getItem('vmd_theme');
  if (storedTheme) {
    state.theme.value = storedTheme;
    document.documentElement.setAttribute('data-theme', storedTheme);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    state.theme.value = 'dark';
  }

  // Init sync and session state
  const initSync = async () => {
    AppSync.init();
    try {
      await AppSync.refreshSession();
    } catch (err) {
      console.warn('Failed to refresh sync session', err);
    }
  };

  if (window.supabase) {
    await initSync();
  } else {
    window.addEventListener('load', () => {
      if (window.supabase) {
        initSync();
      }
    }, { once: true });
  }
};

const App = () => {
  console.log('App rendering, status:', state.status.value);
  const viewMode = state.viewMode.value;

  useEffect(() => {
    // Hide splash screen after initialization
    const run = async () => {
      await initApp();
      setTimeout(() => {
        const splash = document.getElementById('splash');
        if (splash) {
          splash.classList.add('hidden');
          setTimeout(() => splash.remove(), 700);
        }
      }, 500);
    };

    run();
  }, []);

  const status = state.status.value;

  if (status === 'loading') return null;
  if (status === 'setup') return h(SetupView);
  if (status === 'unlock') return h(UnlockView);
  if (status === 'ready') {
    return viewMode === 'raw' ? h(RawView) : h(MainView);
  }

  return h('div', null, 'Unknown state');
};

render(h(App), document.getElementById('app'));
