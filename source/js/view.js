import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { html } from 'htm/preact';
import { parseInline } from 'marked';
import { state } from './state.js';
import { storage } from './storage.js';
import { AppCrypto } from './crypto.js';
import { AppSync } from './sync.js';
import { VMD, getNode, findPath } from './model.js';
import { dispatch, undo, redo } from './update.js';

// --- COMPONENTS ---

// Generic Input Field
export const InputField = ({ label, type = 'text', value, onInput, placeholder, autoFocus }) => {
  const id = label.replace(/\s+/g, '-').toLowerCase();
  return html`
    <div class="input-group">
      <label htmlFor=${id} class="input-label">${label}</label>
      <input
        id=${id}
        type=${type}
        value=${value}
        onInput=${onInput}
        placeholder=${placeholder}
        autoFocus=${autoFocus}
        class="input-field"
      />
    </div>
  `;
};

// Button
export const Button = ({ children, onClick, disabled, variant = 'primary', style, type = 'button' }) => html`
  <button
    type=${type}
    onClick=${onClick}
    disabled=${disabled}
    class=${`btn btn-${variant === 'primary' ? 'primary' : 'secondary'}`}
    style=${style}
  >
    ${children}
  </button>
`;

const updateQuickUnlockOffer = async (passphrase) => {
  state.quickUnlockError.value = null;
  state.quickUnlockPassphrase.value = passphrase;

  try {
    state.quickUnlockSupported.value = await AppCrypto.isQuickUnlockSupported();
  } catch (err) {
    state.quickUnlockSupported.value = false;
  }

  const isEnrolled = storage.hasRaw('vmd_prf_wrapped') && storage.hasRaw('vmd_prf_id');
  state.quickUnlockOfferVisible.value =
    state.quickUnlockSupported.value &&
    !isEnrolled &&
    !state.quickUnlockDismissedSession.value;
};

const resetQuickUnlockLocalState = () => {
  state.quickUnlockSupported.value = false;
  state.quickUnlockOfferVisible.value = false;
  state.quickUnlockPassphrase.value = null;
  state.quickUnlockError.value = null;
  state.quickUnlockFallbackVisible.value = false;
  localStorage.removeItem(AppCrypto.PRF_WRAPPED_KEY);
  localStorage.removeItem(AppCrypto.PRF_ID_KEY);
  localStorage.removeItem(AppCrypto.PRF_DISABLED_KEY);
};

const createInitialDoc = () => ({
  id: 'root',
  text: 'My Notes',
  children: [
    { id: AppCrypto.generateSalt(), text: 'Hello World', children: [] }
  ]
});

export const UnifiedLockView = () => {
  const scenario = state.authScenario.value;
  const [mode, setMode] = useState(state.authMode.value || 'local');
  const [username, setUsername] = useState(state.authLastUsername.value || '');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [canResetRemoteData, setCanResetRemoteData] = useState(false);

  useEffect(() => {
    setMode(state.authMode.value || 'local');
  }, [state.authMode.value]);

  useEffect(() => {
    if (!username && state.authLastUsername.value) {
      setUsername(state.authLastUsername.value);
    }
  }, [state.authLastUsername.value, username]);

  const resetQuickUnlock = () => {
    resetQuickUnlockLocalState();
  };

  const isRemoteSessionValid = mode === 'remote' && scenario === 'remote-session-valid' && !!state.user.value;
  const isLocalCreate = mode === 'local' && !state.authHasLocalData.value;

  const onSwitchMode = async (nextMode) => {
    if (nextMode === mode) return;

    if (mode === 'local' && nextMode === 'remote' && state.authHasLocalData.value) {
      const confirmed = confirm('Switching to remote will remove local encrypted data on this device. Continue?');
      if (!confirmed) return;

      storage.remove('vmd_data');
      state.authHasLocalData.value = false;
      state.authRemotePayload.value = null;
      state.key.value = null;
      state.doc.value = null;
      setMessage('Local encrypted data was cleared. Continue with remote unlock.');
    }

    if (mode === 'remote' && nextMode === 'local' && state.user.value) {
      const confirmed = confirm('Switching to local signs you out and clears local session data. Continue?');
      if (!confirmed) return;

      await AppSync.signOut();
      await AppSync.refreshSession();
      storage.remove('vmd_data');
      state.authHasLocalData.value = false;
      state.authRemotePayload.value = null;
      state.key.value = null;
      state.doc.value = null;
      setMessage('Signed out. Create a new local passphrase to continue.');
    }

    state.authMode.value = nextMode;
    setMode(nextMode);
    setError(null);
    setCanResetRemoteData(false);
    setPassword('');
  };

  const handleRemoteResetData = async () => {
    if (!passphrase.trim()) {
      setError('Enter a new passphrase before resetting remote data.');
      return;
    }

    const confirmed = confirm('This replaces your remote encrypted data with a new empty document. Continue?');
    if (!confirmed) return;

    try {
      state.isBusy.value = true;
      let user = state.user.value;

      if (!user && username.trim() && password) {
        await AppSync.signIn(username.trim(), password);
        user = await AppSync.refreshSession();
      }

      if (!user) {
        setError('Could not validate remote session. Sign in again before resetting data.');
        return;
      }

      const newSalt = AppCrypto.generateSalt();
      storage.setSalt(newSalt);

      const key = await AppCrypto.deriveKey(passphrase, newSalt);
      const initialDoc = createInitialDoc();
      const encryptedData = await AppCrypto.encrypt(JSON.stringify(initialDoc), key);

      await AppSync.upload(encryptedData, newSalt);
      await storage.set('vmd_data', initialDoc, key);

      state.authHasLocalData.value = true;
      state.authRemotePayload.value = {
        salt: newSalt,
        data: encryptedData,
        updated_at: new Date().toISOString()
      };
      state.key.value = key;
      state.doc.value = initialDoc;
      state.status.value = 'ready';
      setCanResetRemoteData(false);
      setMessage('Remote data reset with your new passphrase.');
      await updateQuickUnlockOffer(passphrase);
    } catch (err) {
      console.error(err);
      setError(err?.message || 'Failed to reset remote data.');
    } finally {
      state.isBusy.value = false;
    }
  };

  const handleRemoteSignUp = async () => {
    setError(null);
    setMessage(null);
    setCanResetRemoteData(false);

    if (!username.trim() || !password) {
      setError('Username and password are required.');
      return;
    }
    if (!passphrase.trim()) {
      setError('Passphrase cannot be empty.');
      return;
    }

    try {
      state.isBusy.value = true;
      const result = await AppSync.signUp(username.trim(), password);
      localStorage.setItem('vmd_last_username', username.trim());
      state.authLastUsername.value = username.trim();
      await AppSync.refreshSession();

      if (!result?.user) {
        setMessage('Sign-up submitted. Confirm your email if confirmation is enabled.');
      }
    } catch (err) {
      setError(err?.message || 'Failed to sign up.');
    } finally {
      state.isBusy.value = false;
    }
  };

  const handleRemoteSignOut = async () => {
    try {
      state.isBusy.value = true;
      setError(null);
      setMessage(null);
      setCanResetRemoteData(false);
      await AppSync.signOut();
      await AppSync.refreshSession();
      state.authScenario.value = 'remote-session-expired';
      state.authRemotePayload.value = null;
      state.authMode.value = 'remote';
      setMode('remote');
    } catch (err) {
      setError(err?.message || 'Failed to sign out.');
    } finally {
      state.isBusy.value = false;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setCanResetRemoteData(false);

    try {
      state.isBusy.value = true;

      if (mode === 'local') {
        if (!passphrase.trim()) {
          setError('Passphrase cannot be empty.');
          return;
        }

        const key = await AppCrypto.deriveKey(passphrase, storage.getSalt());

        if (state.authHasLocalData.value) {
          const doc = await storage.get('vmd_data', key);
          if (!doc) {
            throw new Error('Invalid passphrase or corrupted data');
          }

          state.key.value = key;
          state.doc.value = doc;
          state.status.value = 'ready';
          await updateQuickUnlockOffer(passphrase);
          return;
        }

        const initialDoc = createInitialDoc();
        await storage.set('vmd_data', initialDoc, key);
        state.authHasLocalData.value = true;
        state.key.value = key;
        state.doc.value = initialDoc;
        state.status.value = 'ready';
        await updateQuickUnlockOffer(passphrase);
        return;
      }

      if (!state.syncConfigured.value) {
        setError('Remote mode is unavailable because sync is not configured.');
        return;
      }

      if (!passphrase.trim()) {
        setError('Passphrase cannot be empty.');
        return;
      }

      let user = state.user.value;

      if (!isRemoteSessionValid) {
        if (!username.trim() || !password) {
          setError('Username, password, and passphrase are required.');
          return;
        }

        await AppSync.signIn(username.trim(), password);
        localStorage.setItem('vmd_last_username', username.trim());
        state.authLastUsername.value = username.trim();
        user = await AppSync.refreshSession();
      }

      if (!user) {
        setError('Could not validate remote session. Please sign in again.');
        return;
      }

      let remotePayload = state.authRemotePayload.value;
      if (!remotePayload || !remotePayload.data || !remotePayload.salt) {
        remotePayload = await AppSync.download();
      }

      if (remotePayload?.salt) {
        storage.setSalt(remotePayload.salt);
      }

      const key = await AppCrypto.deriveKey(passphrase, storage.getSalt());
      let doc = null;

      if (remotePayload?.data) {
        try {
          const decrypted = await AppCrypto.decrypt(remotePayload.data, key);
          doc = JSON.parse(decrypted);
        } catch (decryptErr) {
          setCanResetRemoteData(true);
          throw new Error('Authenticated, but data could not be decrypted with this passphrase. You can reset remote data with a new passphrase.');
        }
      }

      if (!doc) {
        doc = createInitialDoc();
      }

      await storage.set('vmd_data', doc, key);
      state.authHasLocalData.value = true;
      state.authRemotePayload.value = remotePayload || null;

      state.key.value = key;
      state.doc.value = doc;
      state.status.value = 'ready';
      await updateQuickUnlockOffer(passphrase);
    } catch (err) {
      console.error(err);
      setError(err?.message || 'Failed to unlock.');
    } finally {
      state.isBusy.value = false;
    }
  };

  const unlockDisabled = useMemo(() => {
    if (state.isBusy.value) return true;
    if (mode === 'local') return !passphrase.trim();
    if (isRemoteSessionValid) return !passphrase.trim();
    return !username.trim() || !password || !passphrase.trim();
  }, [mode, passphrase, username, password, isRemoteSessionValid, state.isBusy.value]);

  const passphraseLabel = isLocalCreate ? 'Create a passphrase' : 'Passphrase';
  const subtitle = isLocalCreate
    ? 'No local encrypted data yet. Create a passphrase to start in local mode.'
    : 'Your data is encrypted. Enter your passphrase to unlock.';

  return html`
    <div class="auth-card">
      <h1 class="auth-title">Unlock Virgulas</h1>
      <p class="auth-subtitle">${subtitle}</p>

      <div class="auth-mode-switch" role="group" aria-label="Storage mode">
        <button
          type="button"
          class=${`auth-mode-btn ${mode === 'local' ? 'is-active' : ''}`}
          onClick=${() => onSwitchMode('local')}
        >Local</button>
        <button
          type="button"
          class=${`auth-mode-btn ${mode === 'remote' ? 'is-active' : ''}`}
          onClick=${() => onSwitchMode('remote')}
        >Remote</button>
      </div>

      ${mode === 'remote' && !isRemoteSessionValid && html`
        <${InputField}
          label="Username"
          type="text"
          value=${username}
          onInput=${(e) => setUsername(e.target.value)}
          placeholder="you@example.com"
          autoFocus=${true}
        />
      `}

      ${mode === 'remote' && !isRemoteSessionValid && html`
        <${InputField}
          label="Password"
          type="password"
          value=${password}
          onInput=${(e) => setPassword(e.target.value)}
        />
      `}

      ${mode === 'remote' && isRemoteSessionValid && html`
        <div class="options-hint auth-remote-session-hint">
          ${`Signed in as ${state.user.value?.email || state.user.value?.id}. Enter your passphrase to decrypt synced data.`}
        </div>
      `}

      ${mode === 'remote' && !isRemoteSessionValid && state.syncConfigured.value && html`
        <div class="auth-secondary-actions">
          <${Button}
            variant="secondary"
            disabled=${state.isBusy.value}
            onClick=${handleRemoteSignUp}
          >${state.isBusy.value ? 'Working...' : 'Sign up'}<//>
        </div>
      `}

      ${mode === 'remote' && isRemoteSessionValid && html`
        <div class="auth-secondary-actions">
          <${Button}
            variant="secondary"
            disabled=${state.isBusy.value}
            onClick=${handleRemoteSignOut}
          >${state.isBusy.value ? 'Signing out...' : 'Sign out'}<//>
        </div>
      `}

      ${state.quickUnlockFallbackVisible.value && html`
        <div class="options-section">
          <div class="options-hint">
            Quick unlock is unavailable on this device/browser. You can continue with passphrase unlock or reset quick unlock keys.
          </div>
          <${Button}
            variant="secondary"
            onClick=${resetQuickUnlock}
          >Reset Quick Unlock Keys<//>
        </div>
      `}

      <form onSubmit=${handleSubmit}>
        <${InputField}
          label=${passphraseLabel}
          type="password"
          value=${passphrase}
          onInput=${(e) => setPassphrase(e.target.value)}
          autoFocus=${mode === 'local' || isRemoteSessionValid}
          placeholder=${isLocalCreate ? 'Create a passphrase' : 'Enter your passphrase'}
        />

        ${message && html`<div class="form-success">${message}</div>`}
        ${error && html`<div class="form-error">${error}</div>`}

        ${canResetRemoteData && mode === 'remote' && html`
          <div class="auth-secondary-actions">
            <${Button}
              type="button"
              variant="secondary"
              disabled=${state.isBusy.value || !passphrase.trim()}
              onClick=${handleRemoteResetData}
            >Reset Remote Data With New Passphrase<//>
          </div>
        `}

        <button
          type="submit"
          class="lock-submit-btn"
          disabled=${unlockDisabled}
          aria-label="Unlock"
          title="Unlock"
        >
          ${state.isBusy.value ? '...' : '🔒'}
        </button>
      </form>
    </div>
  `;
};


export const QuickUnlockBanner = () => {
  const [isBusy, setIsBusy] = useState(false);

  if (!state.quickUnlockOfferVisible.value) return null;

  const dismiss = () => {
    state.quickUnlockDismissedSession.value = true;
    state.quickUnlockOfferVisible.value = false;
    state.quickUnlockPassphrase.value = null;
    state.quickUnlockError.value = null;
  };

  const handleEnable = async () => {
    if (!state.quickUnlockPassphrase.value) {
      state.quickUnlockError.value = 'Unlock with your passphrase again to enable quick unlock.';
      return;
    }

    try {
      setIsBusy(true);
      state.quickUnlockError.value = null;
      const result = await AppCrypto.registerQuickUnlock(state.quickUnlockPassphrase.value);
      storage.setRaw('vmd_prf_wrapped', result.wrapped);
      storage.setRaw('vmd_prf_id', result.credentialId);
      state.quickUnlockOfferVisible.value = false;
      state.quickUnlockPassphrase.value = null;
    } catch (err) {
      console.error('Quick unlock registration failed', err);
      AppCrypto.markQuickUnlockUnsupported('registration_failed');
      state.quickUnlockSupported.value = false;
      state.quickUnlockOfferVisible.value = false;
      state.quickUnlockPassphrase.value = null;
      state.quickUnlockFallbackVisible.value = true;
      state.quickUnlockError.value = null;
    } finally {
      setIsBusy(false);
    }
  };

  return html`
    <div class="quick-unlock-banner" role="status">
      <div class="quick-unlock-content">
        <div class="quick-unlock-title">Enable quick unlock on this device?</div>
        <div class="quick-unlock-text">
          Use your device passkey to unlock without typing your passphrase every visit.
        </div>
        ${state.quickUnlockError.value && html`<div class="form-error">${state.quickUnlockError.value}</div>`}
      </div>
      <div class="quick-unlock-actions">
        <${Button}
          onClick=${handleEnable}
          disabled=${isBusy}
          variant="primary"
        >${isBusy ? 'Enabling...' : 'Enable quick unlock'}<//>
        <${Button}
          onClick=${dismiss}
          disabled=${isBusy}
          variant="secondary"
        >Not now<//>
      </div>
    </div>
  `;
};

// --- NODE COMPONENT ---
export const Node = ({ node, path, onUpdate, onAction, readOnly }) => {
  const textRef = useRef(null);
  const descRef = useRef(null);

  const isFocused = state.focusPath.value &&
    state.focusPath.value.length === path.length &&
    state.focusPath.value.every((v, i) => v === path[i]);

  const isSelected = state.selection.value.some((p) =>
    p.length === path.length && p.every((v, i) => v === path[i])
  );

  const focusField = state.focusField.value; // 'text' or 'description'

  const isEditingText = isFocused && !readOnly && focusField === 'text';
  const isEditingDesc = isFocused && !readOnly && focusField === 'description';
  const pathKey = path.join(',');

  // Auto-focus logic
  useEffect(() => {
    if (isEditingText) {
      requestAnimationFrame(() => textRef.current && textRef.current.focus());
    } else if (isEditingDesc) {
      requestAnimationFrame(() => {
        if (!descRef.current) return;
        descRef.current.focus();
      });
    }
  }, [isEditingText, isEditingDesc, pathKey]);

  const handleTextKeyDown = useCallback((e) => {
    if (readOnly || e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      if (e.shiftKey) {
        state.focusField.value = 'description';
      } else {
        onAction('add', path);
      }
    } else if (e.key === 'Backspace' && node.text === '') {
      e.preventDefault();
      onAction('delete', path);
    } else if (e.key === 'Backspace' && node.text !== '' && !e.ctrlKey && e.target && e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
      // At the very beginning of a non-empty node, backspace focuses previous (acts as up arrow)
      e.preventDefault();
      onAction('focusPrev', path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) onAction('moveUp', path);
      else if (!e.shiftKey) onAction('focusPrev', path);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.altKey) onAction('moveDown', path);
      else if (!e.shiftKey) onAction('focusNext', path);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) onAction('unindent', path);
      else onAction('indent', path);
    }
  }, [node, path, onAction, readOnly]);

  const handleDescKeyDown = useCallback((e) => {
    if (readOnly || e.defaultPrevented) return;
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      state.focusField.value = 'text';
    } else if (e.key === 'Backspace' && (!node.description || node.description === '')) {
      e.preventDefault();
      state.focusField.value = 'text';
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.focusField.value = 'text';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onAction('focusNext', path);
    }
  }, [node, path, onAction, readOnly]);

  // Native event listener for robust handling
  useEffect(() => {
    if (!isEditingText) return;
    const el = textRef.current;
    if (!el) return;
    const handler = (e) => handleTextKeyDown(e);
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [handleTextKeyDown, isEditingText]);

  useEffect(() => {
    if (!isEditingDesc) return;
    const el = descRef.current;
    if (!el) return;
    const handler = (e) => handleDescKeyDown(e);
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [handleDescKeyDown, isEditingDesc]);

  const showMarkdownText = !isEditingText && node.text;
  const showMarkdownDesc = !isEditingDesc && node.description;
  const hasDescription = !!node.description;
  const showDescription = hasDescription || isEditingDesc;

  // Truncate description to 2 visible lines in read mode; append ellipsis if more exist.
  const truncateDesc = (text) => {
    if (!text) return { truncated: '', hasMore: false };
    const lines = text.split('\n');
    if (lines.length <= 2) return { truncated: text, hasMore: false };
    return { truncated: `${lines.slice(0, 2).join('\n')}\u2026`, hasMore: true };
  };

  const getFontSize = (depth) => {
    if (depth <= 2) return 'var(--text-size-root)';
    if (depth <= 3) return 'var(--text-size-level-2)';
    return 'var(--text-size-level-3)';
  };

  const nodeContentClass = `node-content${isSelected ? ' node-selected' : ''}${isFocused ? ' node-focused' : ''}`;
  const nodeHighlightStyle = node.id === state.searchCurrentId.value
    ? 'background-color: var(--color-search-current);'
    : node.isMatch
      ? 'background-color: var(--color-search-match);'
      : undefined;

  return html`
    <div class="node" style=${`font-size: ${getFontSize(path.length)};`}>
      <div
        class=${nodeContentClass}
        data-node-id=${node.id}
        onClick=${() => {
      if (readOnly) return;
      state.focusPath.value = path;
      state.focusField.value = 'text';
    }}
        style=${nodeHighlightStyle}
      >
        <span
          class="bullet"
          style=${`margin-right: var(--space-2); cursor: ${readOnly ? 'default' : 'pointer'}; user-select: none; opacity: ${readOnly ? 0.5 : 1}; color: var(--color-text-muted)`}
          draggable=${!readOnly}
          onClick=${(e) => {
      if (readOnly) return;
      e.stopPropagation();
      onAction('zoom', path);
      state.focusPath.value = path.length > 0 && node.children && node.children.length > 0
        ? [...path, 0]
        : path;
    }}
          onDragStart=${(e) => {
      if (readOnly) return;
      e.dataTransfer.setData('application/json', JSON.stringify(path));
      e.dataTransfer.effectAllowed = 'move';
    }}
          onDragOver=${(e) => {
      if (readOnly) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }}
          onDrop=${(e) => {
      if (readOnly) return;
      e.preventDefault();
      try {
        const fromPath = JSON.parse(e.dataTransfer.getData('application/json'));
        if (fromPath.join(',') !== path.join(',')) onAction('move', fromPath, path);
      } catch (err) {
        // Ignore invalid drop payload.
      }
    }}
        >
          ${(node.children && node.children.length > 0) ? (node.collapsed ? '○' : '●') : '•'}
        </span>

        <div class="node-body">
          ${showMarkdownText
      ? html`
                <div
                  class="node-text-md"
                  onClick=${() => {
          if (readOnly) return;
          state.focusPath.value = path;
          state.focusField.value = 'text';
        }}
                  dangerouslySetInnerHTML=${{ __html: parseInline(node.text) }}
                ></div>
              `
      : html`
                <input
                  ref=${textRef}
                  value=${node.text}
                  readOnly=${!!readOnly}
                  onInput=${(e) => !readOnly && onUpdate(path, { text: e.target.value })}
                  onClick=${() => {
          if (readOnly) return;
          state.focusPath.value = path;
          state.focusField.value = 'text';
        }}
                  class="node-text-input"
                  style=${`cursor: ${readOnly ? 'default' : 'text'};`}
                  placeholder=${readOnly ? '' : 'Type here...'}
                />
              `}

          ${showDescription && html`
            <div class="node-description">
              ${showMarkdownDesc
        ? html`
                    <div
                      class="node-desc-md"
                      onClick=${() => {
            if (readOnly) return;
            state.focusPath.value = path;
            state.focusField.value = 'description';
          }}
                      dangerouslySetInnerHTML=${{ __html: parseInline(truncateDesc(node.description).truncated) }}
                    ></div>
                  `
        : html`
                    <textarea
                      ref=${descRef}
                      value=${node.description || ''}
                      readOnly=${!!readOnly}
                      onInput=${(e) => {
            if (!readOnly) {
              onUpdate(path, { description: e.target.value });
            }
          }}
                      onClick=${() => {
            if (readOnly) return;
            state.focusPath.value = path;
            state.focusField.value = 'description';
          }}
                      rows=${1}
                      class="node-desc-textarea"
                      placeholder="Description..."
                    ></textarea>
                  `}
            </div>
          `}
        </div>

        ${node.children && node.children.length > 0 && html`
          <span
            class="collapse-toggle"
            style=${`cursor: ${readOnly ? 'default' : 'pointer'}; user-select: none; color: var(--color-text-muted); font-size: 0.8em; line-height: 1.6;`}
            onClick=${(e) => {
        e.stopPropagation();
        onAction('toggleCollapse', path);
      }}
          >
            ${node.collapsed ? '▶' : '▼'}
          </span>
        `}
      </div>

      ${node.children && node.children.length > 0 && !node.collapsed && html`
        <div class="children">
          ${node.children.map((child, index) => html`
            <${Node}
              key=${child.id}
              node=${child}
              path=${[...path, index]}
              onUpdate=${onUpdate}
              onAction=${onAction}
              readOnly=${readOnly}
            />
          `)}
        </div>
      `}
    </div>
  `;
};

export const Modal = ({ title, onClose, children }) => html`
  <div class="modal-overlay" onClick=${onClose}>
    <div class="modal-dialog" onClick=${(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2 class="modal-title">${title}</h2>
        <button onClick=${onClose} class="modal-close" aria-label="Close">×</button>
      </div>
      ${children}
    </div>
  </div>
`;

export const HelpModal = ({ onClose }) => html`
  <${Modal} title="Keyboard Shortcuts" onClose=${onClose}>
    <ul class="shortcut-list">
      <li class="shortcut-row"><kbd>Enter</kbd><span class="shortcut-desc">Add sibling</span></li>
      <li class="shortcut-row"><kbd>Backspace</kbd><span class="shortcut-desc">Delete empty node</span></li>
      <li class="shortcut-row"><kbd>Tab</kbd><span class="shortcut-desc">Indent</span></li>
      <li class="shortcut-row"><kbd>Shift+Tab</kbd><span class="shortcut-desc">Unindent</span></li>
      <li class="shortcut-row"><kbd>↑ / ↓</kbd><span class="shortcut-desc">Navigate</span></li>
      <li class="shortcut-row"><kbd>Alt+↑/↓</kbd><span class="shortcut-desc">Move node</span></li>
      <li class="shortcut-row"><kbd>Alt+→</kbd><span class="shortcut-desc">Zoom in</span></li>
      <li class="shortcut-row"><kbd>Alt+←</kbd><span class="shortcut-desc">Zoom out</span></li>
      <li class="shortcut-row"><kbd>Ctrl+Z</kbd><span class="shortcut-desc">Undo</span></li>
      <li class="shortcut-row"><kbd>Ctrl+Y</kbd><span class="shortcut-desc">Redo</span></li>
      <li class="shortcut-row"><kbd>Ctrl+F</kbd><span class="shortcut-desc">Search</span></li>
      <li class="shortcut-row"><kbd>Ctrl+Space</kbd><span class="shortcut-desc">Collapse / expand</span></li>
      <li class="shortcut-row"><kbd>Shift+Enter</kbd><span class="shortcut-desc">Edit description</span></li>
    </ul>
  <//>
`;

export const OptionsModal = ({ onClose }) => {
  const [theme, setTheme] = useState(state.theme.value);

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    state.theme.value = newTheme;
    localStorage.setItem('vmd_theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  return html`
    <${Modal} title="Options" onClose=${onClose}>
      <div class="options-section">
        <h3 class="options-section-heading">Theme</h3>
        <div class="options-theme-buttons">
          <${Button}
            variant=${theme === 'light' ? 'primary' : 'secondary'}
            onClick=${() => handleThemeChange('light')}
          >Light<//>
          <${Button}
            variant=${theme === 'dark' ? 'primary' : 'secondary'}
            onClick=${() => handleThemeChange('dark')}
          >Dark<//>
        </div>
      </div>

      <div class="options-section">
        <h3 class="options-section-heading">Source Code</h3>
        <a
          href="https://github.com/pitermarx/Virgulas"
          target="_blank"
          class="repo-link"
        >
          GitHub Repository ↗
        </a>
      </div>

      <div>
        <h3 class="options-section-heading">Data</h3>
        <${Button}
          type="button"
          variant="secondary"
          onClick=${() => {
      if (confirm('Are you sure? This will clear all data and reload.')) {
        localStorage.clear();
        window.location.reload();
      }
    }}
        >Purge All Data<//>
      </div>
    <//>
  `;
};

export const StatusToolbar = () => {
  const [showHelp, setShowHelp] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const syncStatus = state.syncStatus.value;
  const user = state.user.value;
  const viewMode = state.viewMode.value;

  const syncDotStyle = `background-color: ${syncStatus === 'synced' ? 'var(--color-synced)' :
    syncStatus === 'syncing' ? 'var(--color-accent-primary)' :
      syncStatus === 'error' ? 'var(--color-danger)' :
        'var(--color-text-faint)'
    };`;

  return html`
    <div class="status-toolbar">
      <div class="toolbar-actions">
        <button
          onClick=${() => {
      state.viewMode.value = viewMode === 'raw' ? 'outline' : 'raw';
    }}
          class="toolbar-btn"
          style="font-weight: 500;"
        >
          ${viewMode === 'raw' ? 'Back to Outline' : 'RAW'}
        </button>
        <button onClick=${() => setShowHelp(true)} class="toolbar-btn">?</button>
        <button onClick=${() => setShowOptions(true)} class="toolbar-btn">Options</button>
      </div>

      <div class="toolbar-brand">
        ${user && html`
          <span
            class="sync-dot"
            style=${syncDotStyle}
            title=${`Sync: ${syncStatus}`}
          ></span>
        `}
        <span class="status-brand">Virgulas</span>
      </div>

      ${showHelp && html`<${HelpModal} onClose=${() => setShowHelp(false)} />`}
      ${showOptions && html`<${OptionsModal} onClose=${() => setShowOptions(false)} />`}
    </div>
  `;
};

export const RawView = () => {
  const [text, setText] = useState(() => VMD.serialize(state.doc.value));
  const [showSaveCancel, setShowSaveCancel] = useState(false);

  const handleInput = (e) => {
    const newText = e.target.value;
    setText(newText);
    setShowSaveCancel(true);

    try {
      const newDoc = VMD.parse(newText);
      newDoc.text = state.doc.value.text;
      newDoc.id = state.doc.value.id;

      // Preserve the original document structure but update content
      state.doc.value = newDoc;
    } catch (err) {
      console.error('Parse error', err);
    }
  };

  const handleSave = async () => {
    try {
      const newDoc = VMD.parse(text);
      newDoc.text = state.doc.value.text;
      newDoc.id = state.doc.value.id;
      newDoc.updated_at = new Date().toISOString();

      state.doc.value = newDoc;
      await storage.set('vmd_data', newDoc, state.key.value);
      state.viewMode.value = 'outline';
    } catch (err) {
      console.error('Save error', err);
    }
  };

  const handleCancel = () => {
    setText(VMD.serialize(state.doc.value));
    setShowSaveCancel(false);
  };

  return html`
    <div class="raw-view">
      <div class="raw-container">
        <div class="raw-toolbar">
          <h2 class="raw-title">Raw Editor</h2>
          ${showSaveCancel && html`
            <div class="raw-toolbar-actions">
              <${Button} onClick=${handleSave} variant="primary">SAVE<//>
              <${Button} onClick=${handleCancel} variant="secondary">CANCEL<//>
            </div>
          `}
        </div>
        <textarea
          value=${text}
          onInput=${handleInput}
          spellCheck=${false}
          class="raw-editor"
        ></textarea>
      </div>
      <${StatusToolbar} />
    </div>
  `;
};

export const MainView = () => {
  const doc = state.doc.value;
  const focusPath = state.focusPath.value;
  const isPopState = useRef(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef(null);
  const searchMatchPathsRef = useRef([]);
  const [isEditingZoomDesc, setIsEditingZoomDesc] = useState(false);
  const zoomDescRef = useRef(null);
  const [syncConflict, setSyncConflict] = useState(null);
  const [syncConflictChoices, setSyncConflictChoices] = useState({});

  useEffect(() => {
    AppSync.conflictCallback = (payload) => {
      return new Promise((resolve) => {
        setSyncConflict({
          resolve,
          ...payload
        });
      });
    };

    return () => {
      AppSync.conflictCallback = null;
    };
  }, []);

  useEffect(() => {
    if (!syncConflict || syncConflict.type !== 'field-merge') {
      setSyncConflictChoices({});
      return;
    }

    const defaults = {};
    for (const conflict of syncConflict.conflicts || []) {
      defaults[conflict.id] = 'local';
    }
    setSyncConflictChoices(defaults);
  }, [syncConflict]);

  useEffect(() => {
    const runInitialSync = async () => {
      try {
        await AppSync.syncAfterUnlock(state.doc.value, state.key.value);
      } catch (err) {
        console.error('Initial sync after unlock failed', err);
        state.syncStatus.value = navigator.onLine ? 'error' : 'offline';
      }
    };

    runInitialSync();
  }, []);

  useEffect(() => {
    if (!doc) return;

    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const nodeId = params.get('node');
      isPopState.current = true;
      if (nodeId) {
        const path = findPath(doc, nodeId);
        if (path) state.zoomPath.value = path;
      } else {
        state.zoomPath.value = [];
      }
    };

    syncFromUrl();

    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [doc]);

  useEffect(() => {
    if (isPopState.current) {
      isPopState.current = false;
      return;
    }

    const zoom = state.zoomPath.value;
    if (doc) {
      const url = new URL(window.location);
      if (zoom.length > 0) {
        const node = getNode(doc, zoom);
        if (node && url.searchParams.get('node') !== node.id) {
          url.searchParams.set('node', node.id);
          window.history.pushState({}, '', url);
        }
      } else if (url.searchParams.has('node')) {
        url.searchParams.delete('node');
        window.history.pushState({}, '', url);
      }
    }
  }, [state.zoomPath.value, doc]);

  const onUpdate = useCallback((path, changes) => {
    dispatch('update', path, changes);
  }, []);

  const onAction = useCallback((action, path, payload) => {
    dispatch(action, path, payload);
  }, []);

  useEffect(() => {
    const handleGlobalKey = (e) => {
      // Multi-select operations when there's an active selection
      const sel = state.selection.value;
      if (sel.length > 0) {
        if (e.key === 'Escape') {
          e.preventDefault();
          state.selection.value = [];
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          onAction('multiDelete', null);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          onAction(e.shiftKey ? 'multiUnindent' : 'multiIndent', null);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
          e.preventDefault();
          onAction('multiToggleCollapse', null);
          return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => {
          if (searchInputRef.current) searchInputRef.current.focus();
        }, 0);
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          redo();
        } else if (e.key === ' ') {
          // Ctrl+Space toggles collapse
          e.preventDefault();
          if (state.focusPath.value) {
            onAction('toggleCollapse', state.focusPath.value);
          }
        } else if (e.key === 'Backspace') {
          // Ctrl+Backspace deletes node
          e.preventDefault();
          if (state.focusPath.value) {
            onAction('delete', state.focusPath.value);
          }
        }
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (state.focusPath.value && state.focusPath.value.length > 0) {
            const node = getNode(state.doc.value, state.focusPath.value);
            state.zoomPath.value = state.focusPath.value;
            if (node && node.children && node.children.length > 0) {
              state.focusPath.value = [...state.focusPath.value, 0];
            }
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (state.zoomPath.value.length > 0) {
            const currentZoom = state.zoomPath.value;
            state.focusPath.value = currentZoom;
            state.zoomPath.value = currentZoom.slice(0, -1);
          }
        }
      } else if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Multi-select: Shift+up/down selects siblings at same indent level
        e.preventDefault();
        const currentDoc = state.doc.value;
        const zoom = state.zoomPath.value;
        const currentSel = state.selection.value;

        if (currentSel.length > 0) {
          // Extend or shrink existing selection
          const firstPath = currentSel[0];
          const parentPath = firstPath.slice(0, -1);
          const parent = parentPath.length > 0 ? getNode(currentDoc, parentPath) : (zoom.length > 0 ? getNode(currentDoc, zoom) : currentDoc);
          if (!parent || !parent.children) return;
          const selIdxs = currentSel.map((p) => p[p.length - 1]);
          const minIdx = Math.min(...selIdxs);
          const maxIdx = Math.max(...selIdxs);
          if (e.key === 'ArrowUp') {
            const newMin = minIdx - 1;
            if (newMin < 0) return;
            state.selection.value = Array.from({ length: maxIdx - newMin + 1 }, (_, i) => [...parentPath, newMin + i]);
          } else {
            const newMax = maxIdx + 1;
            if (newMax >= parent.children.length) return;
            state.selection.value = Array.from({ length: newMax - minIdx + 1 }, (_, i) => [...parentPath, minIdx + i]);
          }
        } else {
          // Start new selection from focusPath
          const focusedPath = state.focusPath.value;
          if (!focusedPath || focusedPath.length === 0) return;
          const parentPath = focusedPath.slice(0, -1);
          const parent = parentPath.length > 0 ? getNode(currentDoc, parentPath) : (zoom.length > 0 ? getNode(currentDoc, zoom) : currentDoc);
          if (!parent || !parent.children) return;
          const currentIdx = focusedPath[focusedPath.length - 1];
          const newIdx = e.key === 'ArrowUp' ? currentIdx - 1 : currentIdx + 1;
          if (newIdx < 0 || newIdx >= parent.children.length) return;
          state.selection.value = [focusedPath, [...parentPath, newIdx]].sort((a, b) => a[a.length - 1] - b[b.length - 1]);
          // Clear focus when selection starts
          state.focusPath.value = null;
        }
      } else if (e.key === 'Tab' && state.searchQuery.value) {
        // Tab/Shift+Tab cycles through search results
        e.preventDefault();
        const paths = searchMatchPathsRef.current;
        const len = paths.length;
        if (len === 0) return;
        const currentIdx = state.searchIdx.value;
        const newIdx = e.shiftKey ? (currentIdx - 1 + len) % len : (currentIdx + 1) % len;
        state.searchIdx.value = newIdx;
        const match = paths[newIdx];
        if (match) {
          state.searchCurrentId.value = match.id;
          const el = document.querySelector(`[data-node-id="${match.id}"]`);
          if (el) el.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Escape' && document.querySelector('.search-bar')) {
        state.searchQuery.value = '';
        setShowSearch(false);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !state.focusPath.value) {
        // When nothing is focused: up focuses last node, down focuses first node, Enter creates first node if empty
        const currentDoc = state.doc.value;
        if (!currentDoc) return;
        const zoom = state.zoomPath.value;
        const rootNode = zoom.length > 0 ? getNode(currentDoc, zoom) : currentDoc;
        if (!rootNode) return;
        if (!rootNode.children || rootNode.children.length === 0) {
          if (e.key === 'Enter') {
            e.preventDefault();
            onAction('addChild', zoom);
          }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          state.focusPath.value = [...zoom, 0];
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          // Last visible node (last sibling at top level, descend to deepest last child)
          const targetPath = [...zoom, rootNode.children.length - 1];
          let node = rootNode.children[rootNode.children.length - 1];
          while (node && node.children && node.children.length > 0 && !node.collapsed) {
            targetPath.push(node.children.length - 1);
            node = node.children[node.children.length - 1];
          }
          state.focusPath.value = targetPath;
        }
      }
    };

    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, [onAction]);

  // Smart case search: lowercase = insensitive, any uppercase = sensitive
  const smartCaseIncludes = (text, query) => {
    if (!query) return false;
    const hasUppercase = /[A-Z]/.test(query);
    if (hasUppercase) {
      return text.includes(query);
    }
    return text.toLowerCase().includes(query.toLowerCase());
  };

  // Expose dispatch for testing via useEffect
  useEffect(() => {
    window.App.dispatch = onAction;
    document.body.setAttribute('data-main-view', 'rendered');
  });

  const query = state.searchQuery.value;
  const zoomPath = state.zoomPath.value;

  // Reset zoom description editing state when zoom path changes
  useEffect(() => {
    setIsEditingZoomDesc(false);
  }, [zoomPath.join(',')]);

  // Auto-size and focus zoom description textarea when editing starts
  useEffect(() => {
    if (isEditingZoomDesc && zoomDescRef.current) {
      const el = zoomDescRef.current;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
      el.focus();
    }
  }, [isEditingZoomDesc]);

  const displayDoc = useMemo(() => {
    let root = doc;
    if (zoomPath.length > 0) {
      root = getNode(doc, zoomPath);
      if (!root) {
        state.zoomPath.value = [];
        root = doc;
      }
    }

    if (!query || !doc) return root;

    const filter = (node) => {
      const matches = node.text && smartCaseIncludes(node.text, query);
      const children = node.children ? node.children.map(filter).filter(Boolean) : [];
      if (matches || children.length > 0) {
        return { ...node, children, collapsed: false, isMatch: matches };
      }
      return null;
    };

    const newChildren = (root.children || []).map(filter).filter(Boolean);
    return { ...root, children: newChildren };
  }, [doc, query, zoomPath, smartCaseIncludes]);

  // Collect all matching node paths from original doc (for cycling)
  const searchMatchPaths = useMemo(() => {
    if (!query || !doc) return [];
    const results = [];
    const collect = (node, path) => {
      if (node.text && smartCaseIncludes(node.text, query)) {
        results.push({ path, id: node.id });
      }
      if (node.children) {
        node.children.forEach((child, i) => collect(child, [...path, i]));
      }
    };
    const rootNode = zoomPath.length > 0 ? getNode(doc, zoomPath) : doc;
    if (rootNode && rootNode.children) {
      rootNode.children.forEach((child, i) => collect(child, [...zoomPath, i]));
    }
    return results;
  }, [doc, query, zoomPath]);

  // Keep ref up-to-date for global key handler (avoids stale closure)
  useEffect(() => {
    searchMatchPathsRef.current = searchMatchPaths;
  }, [searchMatchPaths]);

  // Reset search index when query changes
  useEffect(() => {
    state.searchIdx.value = 0;
    if (searchMatchPaths.length > 0) {
      state.searchCurrentId.value = searchMatchPaths[0].id;
    } else {
      state.searchCurrentId.value = null;
    }
  }, [query, searchMatchPaths]);

  if (!doc) return html`<div>Loading document...</div>`;

  const breadcrumbs = useMemo(() => {
    if (zoomPath.length === 0) return [];
    const crumbs = [];
    let current = doc;
    crumbs.push({ name: doc.text || 'Root', path: [] });

    for (let i = 0; i < zoomPath.length; i++) {
      if (!current.children) break;
      current = current.children[zoomPath[i]];
      crumbs.push({ name: current.text || 'Untitled', path: zoomPath.slice(0, i + 1) });
    }
    return crumbs;
  }, [doc, zoomPath]);

  const zoomDescriptionContent = (() => {
    if (zoomPath.length === 0) return null;
    const zoomedNode = getNode(doc, zoomPath);
    if (!zoomedNode) return null;
    const desc = zoomedNode.description || '';
    if (isEditingZoomDesc) {
      return html`
        <div class="zoom-description-area">
          <textarea
            ref=${zoomDescRef}
            value=${desc}
            onInput=${(e) => {
          onUpdate(zoomPath, { description: e.target.value });
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
            onBlur=${() => setIsEditingZoomDesc(false)}
            onKeyDown=${(e) => {
          if (e.key === 'Escape') setIsEditingZoomDesc(false);
        }}
            class="zoom-desc-textarea"
            placeholder="Add a description..."
          ></textarea>
        </div>
      `;
    }

    return html`
      <div class="zoom-description-area">
        ${desc
        ? html`
              <div
                class="zoom-desc-display"
                onClick=${() => setIsEditingZoomDesc(true)}
                dangerouslySetInnerHTML=${{ __html: parseInline(desc) }}
              ></div>
            `
        : html`
              <div
                class="zoom-desc-display zoom-desc-placeholder"
                onClick=${() => setIsEditingZoomDesc(true)}
              >
                Add a description...
              </div>
            `}
      </div>
    `;
  })();

  const searchBar = showSearch && html`
    <div class="search-bar">
      <div class="search-bar-inner">
        <input
          ref=${searchInputRef}
          placeholder="Search..."
          value=${query}
          onInput=${(e) => {
      state.searchQuery.value = e.target.value;
    }}
          onKeyDown=${(e) => {
      if (e.key === 'Escape') {
        state.searchQuery.value = '';
        setShowSearch(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const paths = searchMatchPathsRef.current;
        const idx = state.searchIdx.value;
        const match = paths[idx];
        if (match) {
          const origDoc = state.doc.value;
          let closestCollapsedPath = null;
          for (let i = 1; i < match.path.length; i++) {
            const ancestor = getNode(origDoc, match.path.slice(0, i));
            if (ancestor && ancestor.collapsed) {
              closestCollapsedPath = match.path.slice(0, i);
            }
          }
          state.searchQuery.value = '';
          setShowSearch(false);
          if (closestCollapsedPath) {
            state.zoomPath.value = closestCollapsedPath;
          }
          state.focusPath.value = match.path;
        }
      }
    }}
          class="search-input"
        />
        ${query && searchMatchPaths.length > 0 && html`
          <span class="search-counter">${`${state.searchIdx.value + 1}/${searchMatchPaths.length}`}</span>
        `}
        <button
          onClick=${() => {
      state.searchQuery.value = '';
      setShowSearch(false);
    }}
          class="toolbar-btn"
          style="font-size: 1.1rem;"
        >
          ×
        </button>
      </div>
    </div>
  `;

  const outlinerContent = displayDoc.children && displayDoc.children.length > 0
    ? displayDoc.children.map((child, index) => html`
        <${Node}
          key=${child.id}
          node=${child}
          path=${[...zoomPath, index]}
          onUpdate=${onUpdate}
          onAction=${onAction}
          readOnly=${!!query}
        />
      `)
    : !query && html`
        <div
          class="empty-state"
          tabIndex=${0}
          onClick=${() => onAction('addChild', zoomPath)}
          onKeyDown=${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onAction('addChild', zoomPath);
        }
      }}
        >
          Press Enter to add a node...
        </div>
      `;

  const debugPanel = new URLSearchParams(window.location.search).get('debug') === 'true' && html`
    <div class="debug-panel">
      <strong>🐛 Debug Panel</strong>
      <pre style="margin-top: var(--space-2); white-space: pre-wrap; overflow-x: auto;">
${JSON.stringify({
    focusPath: state.focusPath.value,
    zoomPath: state.zoomPath.value,
    selection: state.selection.value,
    historyLength: state.history.value.length,
    futureLength: state.future.value.length,
    syncStatus: state.syncStatus.value,
    nodeCount: doc ? (doc.children || []).length : 0
  }, null, 2)}
      </pre>
    </div>
  `;

  const describeConflictValue = (entry, field) => {
    if (!entry) return '(deleted)';
    if (field === 'childIds') return `${(entry.childIds || []).length} child nodes`;
    if (field === 'description') return entry.description || '(empty)';
    if (field === 'parentId') return entry.parentId || 'root';
    if (field === 'collapsed') return entry.collapsed ? 'collapsed' : 'expanded';
    if (field === 'text') return entry.text || '(empty)';
    return '(n/a)';
  };

  const conflictModal = syncConflict && html`
    <${Modal}
      title="Sync conflict"
      onClose=${() => {
      syncConflict.resolve('local');
      setSyncConflict(null);
    }}
    >
      <div class="options-section">
        <p class="options-hint">
          A newer cloud version was found.
        </p>
        <div class="sync-conflict-meta">
          ${`Local: ${syncConflict.localUpdatedAt || 'unknown'} | Cloud: ${syncConflict.serverUpdatedAt || 'unknown'}`}
        </div>
      </div>

      ${syncConflict.type === 'field-merge' && html`
        <div class="options-section">
          <div class="sync-conflict-meta">
            ${`Auto-merged: ${syncConflict.autoMergedFields || 0} | Pending: ${syncConflict.conflicts?.length || 0}`}
          </div>
          <div class="sync-conflict-list">
            ${(syncConflict.conflicts || []).map((conflict) => {
      const choice = syncConflictChoices[conflict.id] || 'local';
      const chosen = choice === 'local' ? conflict.local : conflict.server;
      const fields = conflict.fields || [];
      return html`
                <div class="sync-conflict-item" key=${`conflict-${conflict.id}`}>
                  ${fields.map((field) => html`
                    <div class="sync-conflict-row" key=${`row-${conflict.id}-${field}`}>
                      <span class="sync-conflict-value">${describeConflictValue(chosen, field)}</span>
                      <div class="sync-conflict-choice">
                        <button
                          class=${`btn ${choice === 'local' ? 'btn-primary' : 'btn-secondary'} btn-xs`}
                          onClick=${() => setSyncConflictChoices((prev) => ({ ...prev, [conflict.id]: 'local' }))}
                        >Local</button>
                        <button
                          class=${`btn ${choice === 'server' ? 'btn-primary' : 'btn-secondary'} btn-xs`}
                          onClick=${() => setSyncConflictChoices((prev) => ({ ...prev, [conflict.id]: 'server' }))}
                        >Cloud</button>
                      </div>
                    </div>
                  `)}
                </div>
              `;
    })}
          </div>
          <div class="options-auth-actions" style="margin-top: var(--space-3);">
            <${Button}
              variant="primary"
              onClick=${() => {
        syncConflict.resolve({ choice: 'merge', choices: syncConflictChoices });
        setSyncConflict(null);
      }}
            >Apply selections<//>
          </div>
        </div>
      `}

      <div class="options-auth-actions">
        <${Button}
          variant="secondary"
          onClick=${() => {
      syncConflict.resolve('local');
      setSyncConflict(null);
    }}
        >Use all local<//>
        <${Button}
          variant="primary"
          onClick=${() => {
      syncConflict.resolve('server');
      setSyncConflict(null);
    }}
        >Use all cloud<//>
      </div>
    <//>
  `;

  return html`
    <div class="main-view">
      <div class="main-content">
        <${QuickUnlockBanner} />
        <div class="main-toolbar">
          ${breadcrumbs.length > 0 && html`
            <div class="breadcrumbs">
              ${breadcrumbs.map((crumb, i) => {
    const isLast = i === breadcrumbs.length - 1;
    return html`
                  <span
                    class=${`breadcrumb-item${isLast ? ' active' : ''}`}
                    key=${`crumb-${i}`}
                    onClick=${() => {
        state.zoomPath.value = crumb.path;
      }}
                  >
                    ${crumb.name}
                  </span>
                `;
  })}
            </div>
          `}
          ${zoomDescriptionContent}
          ${searchBar}
        </div>

        <div class="outliner">
          ${outlinerContent}
        </div>

        ${debugPanel}
        ${conflictModal}
      </div>
      <${StatusToolbar} />
    </div>
  `;
};
