import { h } from 'preact';
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { parseInline } from 'marked';
import { state } from './state.js';
import { storage } from './storage.js';
import { AppCrypto } from './crypto.js';
import { AppSync } from './sync.js';
import { VMD, getNode, findPath } from './model.js';
import { dispatch, undo, redo } from './update.js';

// --- COMPONENTS ---

// Generic Input Field
export const InputField = ({ label, type = "text", value, onInput, placeholder, autoFocus }) => {
  const id = label.replace(/\s+/g, '-').toLowerCase();
  return h('div', { className: 'input-group' }, [
    h('label', { htmlFor: id, className: 'input-label' }, label),
    h('input', {
      id,
      type,
      value,
      onInput,
      placeholder,
      autoFocus,
      className: 'input-field'
    })
  ]);
};

// Button
export const Button = ({ children, onClick, disabled, variant = 'primary', style }) => (
  h('button', {
    onClick,
    disabled,
    className: `btn btn-${variant === 'primary' ? 'primary' : 'secondary'}`,
    style
  }, children)
);

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
  AppCrypto.resetQuickUnlockLocalData();
  state.quickUnlockSupported.value = false;
  state.quickUnlockOfferVisible.value = false;
  state.quickUnlockPassphrase.value = null;
  state.quickUnlockError.value = null;
  state.quickUnlockFallbackVisible.value = false;
};

export const SetupView = () => {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (passphrase !== confirm) {
      setError("Passphrases do not match");
      return;
    }
    if (passphrase.length < 1) {
      setError("Passphrase cannot be empty");
      return;
    }

    try {
      state.isBusy.value = true;
      const salt = storage.getSalt();
      const key = await AppCrypto.deriveKey(passphrase, salt);

      // Initialize empty document
      const initialDoc = {
        id: 'root',
        text: 'My Notes',
        children: [
          { id: AppCrypto.generateSalt(), text: 'Hello World', children: [] }
        ]
      };

      await storage.set('vmd_data', initialDoc, key);

      state.key.value = key;
      state.doc.value = initialDoc;
      state.status.value = 'ready';
    } catch (err) {
      setError(err.message);
    } finally {
      state.isBusy.value = false;
    }
  };

  return h('div', { className: 'auth-card' }, [
    h('h1', { className: 'auth-title' }, 'Welcome to Virgulas'),
    h('p', { className: 'auth-subtitle' },
      'Your data is encrypted locally. If you lose this passphrase, your data is lost forever.'),
    h('form', { onSubmit: handleSubmit }, [
      h(InputField, {
        label: 'Create Passphrase',
        type: 'password',
        value: passphrase,
        onInput: e => setPassphrase(e.target.value),
        autoFocus: true
      }),
      h(InputField, {
        label: 'Confirm Passphrase',
        type: 'password',
        value: confirm,
        onInput: e => setConfirm(e.target.value)
      }),
      error && h('div', { className: 'form-error' }, error),
      h(Button, { disabled: state.isBusy.value, style: 'width: 100%;' }, state.isBusy.value ? 'Setting up...' : 'Start Writing')
    ])
  ]);
};

export const UnlockView = () => {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState(null);

  const resetQuickUnlock = () => {
    resetQuickUnlockLocalState();
  };

  const handleUnlock = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      state.isBusy.value = true;
      const salt = storage.getSalt();
      const key = await AppCrypto.deriveKey(passphrase, salt);

      // Try to decrypt data
      const doc = await storage.get('vmd_data', key);

      if (!doc) {
        throw new Error("Invalid passphrase or corrupted data");
      }

      state.key.value = key;
      state.doc.value = doc;
      state.status.value = 'ready';
      await updateQuickUnlockOffer(passphrase);
    } catch (err) {
      console.error(err);
      setError("Invalid passphrase. Please try again.");
    } finally {
      state.isBusy.value = false;
    }
  };

  return h('div', { className: 'auth-card' }, [
    h('h1', { className: 'auth-title' }, 'Welcome Back'),
    state.quickUnlockFallbackVisible.value && h('div', { className: 'options-section' }, [
      h('div', { className: 'options-hint' },
        'Quick unlock is unavailable on this device/browser. You can continue with passphrase unlock or reset quick unlock keys.'),
      h(Button, {
        variant: 'secondary',
        onClick: resetQuickUnlock
      }, 'Reset Quick Unlock Keys')
    ]),
    h('form', { onSubmit: handleUnlock }, [
      h(InputField, {
        label: 'Passphrase',
        type: 'password',
        value: passphrase,
        onInput: e => setPassphrase(e.target.value),
        autoFocus: true
      }),
      error && h('div', { className: 'form-error' }, error),
      h(Button, { disabled: state.isBusy.value, style: 'width: 100%;' }, state.isBusy.value ? 'Unlocking...' : 'Unlock')
    ])
  ]);
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

  return h('div', { className: 'quick-unlock-banner', role: 'status' }, [
    h('div', { className: 'quick-unlock-content' }, [
      h('div', { className: 'quick-unlock-title' }, 'Enable quick unlock on this device?'),
      h('div', { className: 'quick-unlock-text' },
        'Use your device passkey to unlock without typing your passphrase every visit.'),
      state.quickUnlockError.value && h('div', { className: 'form-error' }, state.quickUnlockError.value)
    ]),
    h('div', { className: 'quick-unlock-actions' }, [
      h(Button, {
        onClick: handleEnable,
        disabled: isBusy,
        variant: 'primary'
      }, isBusy ? 'Enabling...' : 'Enable quick unlock'),
      h(Button, {
        onClick: dismiss,
        disabled: isBusy,
        variant: 'secondary'
      }, 'Not now')
    ])
  ]);
};

// --- NODE COMPONENT ---
export const Node = ({ node, path, onUpdate, onAction, readOnly }) => {
  const textRef = useRef(null);
  const descRef = useRef(null);

  const isFocused = state.focusPath.value &&
    state.focusPath.value.length === path.length &&
    state.focusPath.value.every((v, i) => v === path[i]);

  const isSelected = state.selection.value.some(p =>
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
        const el = descRef.current;
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
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
      // At the very beginning of a non-empty node, backspace focuses previous (acts as ↑)
      e.preventDefault();
      onAction('focusPrev', path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) onAction('moveUp', path);
      else if (!e.shiftKey) onAction('focusPrev', path);
      // Shift+ArrowUp: handled by global handler for multi-select (don't focusPrev)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.altKey) onAction('moveDown', path);
      else if (!e.shiftKey) onAction('focusNext', path);
      // Shift+ArrowDown: handled by global handler for multi-select (don't focusNext)
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

  // Truncate description to 2 visible lines in read mode; append "…" if more exist
  const truncateDesc = (text) => {
    if (!text) return { truncated: '', hasMore: false };
    const lines = text.split('\n');
    if (lines.length <= 2) return { truncated: text, hasMore: false };
    return { truncated: lines.slice(0, 2).join('\n') + '\u2026', hasMore: true };
  };

  const getFontSize = (depth) => {
    if (depth === 0) return 'var(--text-size-root)';
    if (depth === 1) return 'var(--text-size-level-2)';
    return 'var(--text-size-level-3)';
  };

  return h('div', { className: 'node', style: `font-size: ${getFontSize(path.length)};` }, [
    h('div', {
      className: `node-content${isSelected ? ' node-selected' : ''}${isFocused ? ' node-focused' : ''}`,
      'data-node-id': node.id,
      onClick: () => {
        if (readOnly) return;
        state.focusPath.value = path;
        state.focusField.value = 'text';
      },
      style: node.id === state.searchCurrentId.value
        ? 'background-color: var(--color-search-current);'
        : node.isMatch
          ? 'background-color: var(--color-search-match);'
          : undefined
    }, [
      h('span', {
        className: 'bullet',
        style: `margin-right: var(--space-2); cursor: ${readOnly ? 'default' : 'pointer'}; user-select: none; opacity: ${readOnly ? 0.5 : 1}; color: var(--color-text-muted)`,
        draggable: !readOnly,
        onclick: (e) => {
          if (readOnly) return;
          e.stopPropagation();
          onAction('zoom', path);
          state.focusPath.value = path.length > 0 && node.children && node.children.length > 0
            ? [...path, 0]
            : path;
        },
        ondragstart: (e) => {
          if (readOnly) return;
          e.dataTransfer.setData('application/json', JSON.stringify(path));
          e.dataTransfer.effectAllowed = 'move';
        },
        ondragover: (e) => {
          if (readOnly) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        },
        ondrop: (e) => {
          if (readOnly) return;
          e.preventDefault();
          try {
            const fromPath = JSON.parse(e.dataTransfer.getData('application/json'));
            if (fromPath.join(',') !== path.join(',')) onAction('move', fromPath, path);
          } catch (err) { }
        }
      }, (node.children && node.children.length > 0) ? (node.collapsed ? '○' : '●') : '•'),

      h('div', { className: 'node-body' }, [
        showMarkdownText ?
          h('div', {
            className: 'node-text-md',
            onClick: () => {
              if (readOnly) return;
              state.focusPath.value = path;
              state.focusField.value = 'text';
            },
            dangerouslySetInnerHTML: { __html: parseInline(node.text) }
          }) :
          h('input', {
            ref: textRef,
            value: node.text,
            readOnly: !!readOnly,
            onInput: (e) => !readOnly && onUpdate(path, { text: e.target.value }),
            onClick: () => {
              if (readOnly) return;
              state.focusPath.value = path;
              state.focusField.value = 'text';
            },
            className: 'node-text-input',
            style: `cursor: ${readOnly ? 'default' : 'text'};`,
            placeholder: readOnly ? '' : 'Type here...'
          }),

        showDescription && h('div', { className: 'node-description' }, [
          showMarkdownDesc ?
            h('div', {
              className: 'node-desc-md',
              onClick: () => {
                if (readOnly) return;
                state.focusPath.value = path;
                state.focusField.value = 'description';
              },
              dangerouslySetInnerHTML: { __html: parseInline(truncateDesc(node.description).truncated) }
            }) :
            h('textarea', {
              ref: descRef,
              value: node.description || '',
              readOnly: !!readOnly,
              onInput: (e) => {
                if (!readOnly) {
                  onUpdate(path, { description: e.target.value });
                  e.target.style.height = 'auto';
                  e.target.style.height = e.target.scrollHeight + 'px';
                }
              },
              onClick: () => {
                if (readOnly) return;
                state.focusPath.value = path;
                state.focusField.value = 'description';
              },
              rows: 1,
              className: 'node-desc-textarea',
              placeholder: 'Description...'
            })
        ])
      ]),

      node.children && node.children.length > 0 && h('span', {
        className: 'collapse-toggle',
        style: `cursor: ${readOnly ? 'default' : 'pointer'}; user-select: none; color: var(--color-text-muted); font-size: 0.8em; line-height: 1.6;`,
        onclick: (e) => {
          e.stopPropagation();
          onAction('toggleCollapse', path);
        }
      }, node.collapsed ? '▶' : '▼'),

    ]),
    node.children && node.children.length > 0 && !node.collapsed && h('div', { className: 'children' },
      node.children.map((child, index) =>
        h(Node, {
          key: child.id,
          node: child,
          path: [...path, index],
          onUpdate,
          onAction,
          readOnly
        })
      )
    )
  ]);
};

export const Modal = ({ title, onClose, children }) => (
  h('div', { className: 'modal-overlay', onClick: onClose }, [
    h('div', { className: 'modal-dialog', onClick: e => e.stopPropagation() }, [
      h('div', { className: 'modal-header' }, [
        h('h2', { className: 'modal-title' }, title),
        h('button', { onClick: onClose, className: 'modal-close', 'aria-label': 'Close' }, '×')
      ]),
      children
    ])
  ])
);

export const HelpModal = ({ onClose }) => (
  h(Modal, { title: 'Keyboard Shortcuts', onClose }, [
    h('ul', { className: 'shortcut-list' }, [
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Enter'), h('span', { className: 'shortcut-desc' }, 'Add sibling')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Backspace'), h('span', { className: 'shortcut-desc' }, 'Delete empty node')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Tab'), h('span', { className: 'shortcut-desc' }, 'Indent')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Shift+Tab'), h('span', { className: 'shortcut-desc' }, 'Unindent')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, '↑ / ↓'), h('span', { className: 'shortcut-desc' }, 'Navigate')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Alt+↑/↓'), h('span', { className: 'shortcut-desc' }, 'Move node')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Alt+→'), h('span', { className: 'shortcut-desc' }, 'Zoom in')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Alt+←'), h('span', { className: 'shortcut-desc' }, 'Zoom out')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Ctrl+Z'), h('span', { className: 'shortcut-desc' }, 'Undo')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Ctrl+Y'), h('span', { className: 'shortcut-desc' }, 'Redo')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Ctrl+F'), h('span', { className: 'shortcut-desc' }, 'Search')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Ctrl+Space'), h('span', { className: 'shortcut-desc' }, 'Collapse / expand')]),
      h('li', { className: 'shortcut-row' }, [h('kbd', null, 'Shift+Enter'), h('span', { className: 'shortcut-desc' }, 'Edit description')]),
    ])
  ])
);

export const OptionsModal = ({ onClose }) => {
  const [theme, setTheme] = useState(state.theme.value);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authMessage, setAuthMessage] = useState(null);
  const [dataMessage, setDataMessage] = useState(null);
  const user = state.user.value;

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme);
    state.theme.value = newTheme;
    localStorage.setItem('vmd_theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const syncAfterAuth = async () => {
    const result = await AppSync.syncAfterUnlock(state.doc.value, state.key.value);
    if (!result.success) {
      setAuthError('Authentication succeeded, but initial sync failed.');
    }
  };

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      setAuthError('Email and password are required.');
      return;
    }

    try {
      setAuthBusy(true);
      setAuthError(null);
      setAuthMessage(null);
      await AppSync.signIn(email.trim(), password);
      await syncAfterAuth();
      setPassword('');
    } catch (err) {
      setAuthError(err?.message || 'Failed to sign in.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignUp = async () => {
    if (!email.trim() || !password) {
      setAuthError('Email and password are required.');
      return;
    }

    try {
      setAuthBusy(true);
      setAuthError(null);
      setAuthMessage(null);
      const result = await AppSync.signUp(email.trim(), password);
      await syncAfterAuth();
      setPassword('');
      if (!result?.user) {
        setAuthMessage('Sign-up submitted. Confirm your email if confirmation is enabled.');
      }
    } catch (err) {
      setAuthError(err?.message || 'Failed to sign up.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    try {
      setAuthBusy(true);
      setAuthError(null);
      setAuthMessage(null);
      await AppSync.signOut();
      await AppSync.refreshSession();
    } catch (err) {
      setAuthError(err?.message || 'Failed to sign out.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleResetQuickUnlockKeys = () => {
    resetQuickUnlockLocalState();
    setDataMessage('Quick unlock keys reset for this browser profile.');
  };

  return h(Modal, { title: 'Options', onClose }, [
    h('div', { className: 'options-section' }, [
      h('h3', { className: 'options-section-heading' }, 'Theme'),
      h('div', { className: 'options-theme-buttons' }, [
        h(Button, {
          variant: theme === 'light' ? 'primary' : 'secondary',
          onClick: () => handleThemeChange('light')
        }, 'Light'),
        h(Button, {
          variant: theme === 'dark' ? 'primary' : 'secondary',
          onClick: () => handleThemeChange('dark')
        }, 'Dark')
      ])
    ]),
    h('div', { className: 'options-section' }, [
      h('h3', { className: 'options-section-heading' }, 'Source Code'),
      h('a', {
        href: 'https://github.com/pitermarx/Virgulas',
        target: '_blank',
        className: 'repo-link'
      }, 'GitHub Repository ↗')
    ]),
    h('div', { className: 'options-section' }, [
      h('h3', { className: 'options-section-heading' }, 'Account & Sync'),
      !AppSync.client && h('div', { className: 'options-hint' },
        'Sync is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY to enable account features.'
      ),
      AppSync.client && !user && h('div', { className: 'options-auth-form' }, [
        h(InputField, {
          label: 'Email',
          type: 'email',
          value: email,
          onInput: e => setEmail(e.target.value),
          placeholder: 'you@example.com'
        }),
        h(InputField, {
          label: 'Password',
          type: 'password',
          value: password,
          onInput: e => setPassword(e.target.value)
        }),
        authError && h('div', { className: 'form-error' }, authError),
        authMessage && h('div', { className: 'form-success' }, authMessage),
        h('div', { className: 'options-auth-actions' }, [
          h(Button, {
            variant: 'secondary',
            disabled: authBusy,
            onClick: handleSignUp
          }, authBusy ? 'Working...' : 'Sign up'),
          h(Button, {
            variant: 'primary',
            disabled: authBusy,
            onClick: handleSignIn
          }, authBusy ? 'Working...' : 'Sign in')
        ])
      ]),
      AppSync.client && user && h('div', { className: 'options-auth-signed' }, [
        h('div', { className: 'options-hint' }, `Signed in as ${user.email || user.id}`),
        authError && h('div', { className: 'form-error' }, authError),
        h(Button, {
          variant: 'secondary',
          disabled: authBusy,
          onClick: handleSignOut
        }, authBusy ? 'Signing out...' : 'Sign out')
      ])
    ]),
    h('div', null, [
      h('h3', { className: 'options-section-heading' }, 'Data'),
      dataMessage && h('div', { className: 'form-success' }, dataMessage),
      h(Button, {
        variant: 'secondary',
        onClick: handleResetQuickUnlockKeys
      }, 'Reset Quick Unlock Keys'),
      h(Button, { variant: 'secondary', onClick: () => { if (confirm('Are you sure? This will clear all data and reload.')) { localStorage.clear(); window.location.reload(); } } }, 'Purge All Data')
    ])
  ]);
};

export const StatusToolbar = () => {
  const [showHelp, setShowHelp] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const syncStatus = state.syncStatus.value;
  const user = state.user.value;
  const viewMode = state.viewMode.value;

  return h('div', { className: 'status-toolbar' }, [
    h('div', { className: 'toolbar-actions' }, [
      h('button', {
        onClick: () => state.viewMode.value = viewMode === 'raw' ? 'outline' : 'raw',
        className: 'toolbar-btn',
        style: 'font-weight: 500;'
      }, viewMode === 'raw' ? 'Back to Outline' : 'RAW'),
      h('button', { onClick: () => setShowHelp(true), className: 'toolbar-btn' }, '?'),
      h('button', { onClick: () => setShowOptions(true), className: 'toolbar-btn' }, 'Options')
    ]),

    h('div', { className: 'toolbar-brand' }, [
      user && h('span', {
        className: 'sync-dot',
        style: `background-color: ${syncStatus === 'synced' ? 'var(--color-synced)' :
          syncStatus === 'syncing' ? 'var(--color-accent-primary)' :
            syncStatus === 'error' ? 'var(--color-danger)' :
              'var(--color-text-faint)'
          };`,
        title: `Sync: ${syncStatus}`
      }),
      h('span', { className: 'status-brand' }, 'Virgulas')
    ]),

    showHelp && h(HelpModal, { onClose: () => setShowHelp(false) }),
    showOptions && h(OptionsModal, { onClose: () => setShowOptions(false) })
  ]);
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
      console.error("Parse error", err);
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
      console.error("Save error", err);
    }
  };

  const handleCancel = () => {
    setText(VMD.serialize(state.doc.value)); // Reset to current document
    setShowSaveCancel(false);
  };

  return h('div', { className: 'raw-view' }, [
    h('div', { className: 'raw-container' }, [
      h('div', { className: 'raw-toolbar' }, [
        h('h2', { className: 'raw-title' }, 'Raw Editor'),
        showSaveCancel && h('div', { className: 'raw-toolbar-actions' }, [
          h(Button, { onClick: handleSave, variant: 'primary' }, 'SAVE'),
          h(Button, { onClick: handleCancel, variant: 'secondary' }, 'CANCEL')
        ])
      ]),
      h('textarea', {
        value: text,
        onInput: handleInput,
        spellCheck: false,
        className: 'raw-editor'
      })
    ]),
    h(StatusToolbar)
  ]);
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

  useEffect(() => {
    AppSync.conflictCallback = (serverData, localDoc) => {
      return new Promise((resolve) => {
        setSyncConflict({
          resolve,
          serverUpdatedAt: serverData?.updated_at || null,
          localUpdatedAt: localDoc?.updated_at || null
        });
      });
    };

    return () => {
      AppSync.conflictCallback = null;
    };
  }, []);

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
      // Reset flag after a tick to ensure the effect sees it? 
      // Actually, state update is synchronous usually with signals but effects run after render.
    };

    syncFromUrl(); // Initial load

    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [doc]);

  useEffect(() => {
    if (isPopState.current) {
      isPopState.current = false;
      return;
    }

    const zoom = state.zoomPath.value;
    if (doc) { // Ensure doc is loaded
      const url = new URL(window.location);
      if (zoom.length > 0) {
        const node = getNode(doc, zoom);
        if (node) {
          if (url.searchParams.get('node') !== node.id) {
            url.searchParams.set('node', node.id);
            window.history.pushState({}, '', url);
          }
        }
      } else {
        if (url.searchParams.has('node')) {
          url.searchParams.delete('node');
          window.history.pushState({}, '', url);
        }
      }
    }
  }, [state.zoomPath.value, doc]);

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
            // state.zoomPath.value = state.focusPath.value; // Don't use this directly, use dispatch? No, state update is fine.
            // But Wait! SPEC says: "Alt+Right zooms into a node".
            // My code does: update zoomPath.
            // And Effect handles URL push.
            // But existing code:
            // state.zoomPath.value = state.focusPath.value;
            // if (node && node.children && node.children.length > 0) {
            //    state.focusPath.value = [...state.focusPath.value, 0];
            // }
            // This logic is fine.
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
        // Multi-select: Shift+↑/↓ selects siblings at same indent level
        e.preventDefault();
        const doc = state.doc.value;
        const zoom = state.zoomPath.value;
        const currentSel = state.selection.value;

        if (currentSel.length > 0) {
          // Extend or shrink existing selection
          const firstPath = currentSel[0];
          const parentPath = firstPath.slice(0, -1);
          const parent = parentPath.length > 0 ? getNode(doc, parentPath) : (zoom.length > 0 ? getNode(doc, zoom) : doc);
          if (!parent || !parent.children) return;
          const selIdxs = currentSel.map(p => p[p.length - 1]);
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
          const focusPath = state.focusPath.value;
          if (!focusPath || focusPath.length === 0) return;
          const parentPath = focusPath.slice(0, -1);
          const parent = parentPath.length > 0 ? getNode(doc, parentPath) : (zoom.length > 0 ? getNode(doc, zoom) : doc);
          if (!parent || !parent.children) return;
          const currentIdx = focusPath[focusPath.length - 1];
          const newIdx = e.key === 'ArrowUp' ? currentIdx - 1 : currentIdx + 1;
          if (newIdx < 0 || newIdx >= parent.children.length) return;
          state.selection.value = [focusPath, [...parentPath, newIdx]].sort((a, b) => a[a.length - 1] - b[b.length - 1]);
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
        // When nothing is focused: ↑ focuses last node, ↓ focuses first node, Enter creates first node if empty
        const doc = state.doc.value;
        if (!doc) return;
        const zoom = state.zoomPath.value;
        const rootNode = zoom.length > 0 ? getNode(doc, zoom) : doc;
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
          let targetPath = [...zoom, rootNode.children.length - 1];
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
  }, []);

  // Smart case search: lowercase = insensitive, any uppercase = sensitive
  const smartCaseIncludes = (text, query) => {
    if (!query) return false;
    const hasUppercase = /[A-Z]/.test(query);
    if (hasUppercase) {
      return text.includes(query);
    } else {
      return text.toLowerCase().includes(query.toLowerCase());
    }
  };

  const onUpdate = useCallback((path, changes) => {
    dispatch('update', path, changes);
  }, []);

  const onAction = useCallback((action, path, payload) => {
    dispatch(action, path, payload);
  }, []);

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
      el.style.height = el.scrollHeight + 'px';
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
  }, [query]);

  if (!doc) return h('div', null, 'Loading document...');

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

  return h('div', { className: 'main-view' }, [
    h('div', { className: 'main-content' }, [
      h(QuickUnlockBanner),
      h('div', { className: 'main-toolbar' }, [
        breadcrumbs.length > 0 && h('div', { className: 'breadcrumbs' },
          breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return h('span', {
              className: `breadcrumb-item${isLast ? ' active' : ''}`,
              key: `crumb-${i}`,
              onclick: () => state.zoomPath.value = crumb.path
            }, crumb.name);
          })
        ),
        zoomPath.length > 0 && (() => {
          const zoomedNode = getNode(doc, zoomPath);
          if (!zoomedNode) return null;
          const desc = zoomedNode.description || '';
          if (isEditingZoomDesc) {
            return h('div', { className: 'zoom-description-area' },
              h('textarea', {
                ref: zoomDescRef,
                value: desc,
                onInput: (e) => {
                  onUpdate(zoomPath, { description: e.target.value });
                  e.target.style.height = 'auto';
                  e.target.style.height = e.target.scrollHeight + 'px';
                },
                onBlur: () => setIsEditingZoomDesc(false),
                onKeyDown: (e) => {
                  if (e.key === 'Escape') setIsEditingZoomDesc(false);
                },
                className: 'zoom-desc-textarea',
                placeholder: 'Add a description...'
              })
            );
          }
          return h('div', { className: 'zoom-description-area' },
            h('div', {
              className: `zoom-desc-display${!desc ? ' zoom-desc-placeholder' : ''}`,
              onClick: () => setIsEditingZoomDesc(true),
              dangerouslySetInnerHTML: desc
                ? { __html: parseInline(desc) }
                : undefined
            }, !desc ? 'Add a description...' : undefined)
          );
        })(),
        showSearch && h('div', { className: 'search-bar' }, [
          h('div', { className: 'search-bar-inner' }, [
            h('input', {
              ref: searchInputRef,
              placeholder: 'Search...',
              value: query,
              onInput: (e) => state.searchQuery.value = e.target.value,
              onKeyDown: (e) => {
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
              },
              className: 'search-input'
            }),
            query && searchMatchPaths.length > 0 && h('span', {
              className: 'search-counter'
            }, `${state.searchIdx.value + 1}/${searchMatchPaths.length}`),
            h('button', {
              onClick: () => { state.searchQuery.value = ''; setShowSearch(false); },
              className: 'toolbar-btn',
              style: 'font-size: 1.1rem;'
            }, '×')
          ])
        ])
      ]),
      h('div', { className: 'outliner' },
        displayDoc.children && displayDoc.children.length > 0
          ? displayDoc.children.map((child, index) =>
            h(Node, {
              key: child.id,
              node: child,
              path: [...zoomPath, index],
              onUpdate: onUpdate,
              onAction: onAction,
              readOnly: !!query
            })
          )
          : !query && h('div', {
            className: 'empty-state',
            tabIndex: 0,
            onClick: () => onAction('addChild', zoomPath),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAction('addChild', zoomPath);
              }
            }
          }, 'Press Enter to add a node...')
      ),
      new URLSearchParams(window.location.search).get('debug') === 'true' && h('div', {
        className: 'debug-panel'
      }, [
        h('strong', null, '🐛 Debug Panel'),
        h('pre', { style: 'margin-top: var(--space-2); white-space: pre-wrap; overflow-x: auto;' },
          JSON.stringify({
            focusPath: state.focusPath.value,
            zoomPath: state.zoomPath.value,
            selection: state.selection.value,
            historyLength: state.history.value.length,
            futureLength: state.future.value.length,
            syncStatus: state.syncStatus.value,
            nodeCount: doc ? (doc.children || []).length : 0
          }, null, 2)
        )
      ]),
      syncConflict && h(Modal, {
        title: 'Sync conflict',
        onClose: () => {
          syncConflict.resolve('local');
          setSyncConflict(null);
        }
      }, [
        h('div', { className: 'options-section' }, [
          h('p', { className: 'options-hint' },
            'A newer cloud version was found. Choose which version should win. Virgulas does not merge documents automatically.'
          ),
          h('div', { className: 'options-hint' }, `Local updated: ${syncConflict.localUpdatedAt || 'unknown'}`),
          h('div', { className: 'options-hint' }, `Cloud updated: ${syncConflict.serverUpdatedAt || 'unknown'}`)
        ]),
        h('div', { className: 'options-auth-actions' }, [
          h(Button, {
            variant: 'secondary',
            onClick: () => {
              syncConflict.resolve('local');
              setSyncConflict(null);
            }
          }, 'Keep local'),
          h(Button, {
            variant: 'primary',
            onClick: () => {
              syncConflict.resolve('server');
              setSyncConflict(null);
            }
          }, 'Keep cloud')
        ])
      ]),
    ]),
    h(StatusToolbar)
  ]);
};
