// ── App ───────────────────────────────────────────────────────────────────────
// Entry point: DOM and async effects dispatch messages into update.js.

import { findNode, flatVisible, renderInline } from './model.js';
import State from './state.js';
import {
    render,
    renderSyncStatus,
    renderAuthUI,
    renderLoginMode,
    applyDevMode,
    applyTheme,
    showDescEditor,
    renderDescView,
    autoResize,
    updateStorageIndicator,
    renderChrome,
    applySelectionHighlights,
    byId,
    setCursor,
    showToast,
} from './view.js';
import { update, syncSnapshot } from './update.js';
import {
    initAuth,
    registerAuthListener,
    submitLogin,
    performSignOut,
    performDeleteAccount,
    syncNow,
    pushResolvedDoc,
} from './sync.js';

const isCmdKey = (event, key) => (event.ctrlKey || event.metaKey) && event.key === key;
const isPlainKey = (event, key) => event.key === key && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
const isArrowKey = (event, key) => event.key === key && !event.altKey && !event.ctrlKey && !event.metaKey;
const isArrowNoMods = (event, key) => isArrowKey(event, key) && !event.shiftKey;

const bulletsEl = byId('bullets');
const breadcrumbEl = byId('breadcrumb');
const zoomDescEl = byId('zoom-desc');
const EDIT_STATE = new WeakMap();
const BULLET_TEXT = '.bullet-text[data-id]';
const BULLET_DESC = '.bullet-desc';

function on(id, event, handler) {
    byId(id)?.addEventListener(event, handler);
}

function renderApp() {
    render();
    renderLoginMode();
    renderAuthUI();
    renderSyncStatus();
    applyDevMode();
    renderChrome();
    void updateStorageIndicator();
}

function beginEdit(target, value) {
    EDIT_STATE.set(target, { value, changed: false });
}

function touchEdit(target, value) {
    const session = EDIT_STATE.get(target);
    if (!session) return false;
    if (!session.changed && value !== session.value) session.changed = true;
    return session.changed;
}

function endEdit(target) {
    const session = EDIT_STATE.get(target);
    EDIT_STATE.delete(target);
    return !!session?.changed;
}

function focusGhostText() {
    document.querySelectorAll('.bullet-row.focused, .ghost-row.focused').forEach((el) => el.classList.remove('focused'));
    const ghostText = byId('ghost-text');
    State.focusedId = null;
    ghostText?.closest('.ghost-row')?.classList.add('focused');
    ghostText?.focus();
}

function focusBullet(id, cursor = 'end') {
    const el = document.querySelector(`.bullet-text[data-id="${id}"]`);
    if (!el) return false;
    const preserveSelection = State.selectedIds.length > 0;
    document.querySelectorAll('.bullet-row.focused, .ghost-row.focused').forEach((row) => row.classList.remove('focused'));
    el.closest('.bullet-row')?.classList.add('focused');
    State.focusedId = id;
    if (preserveSelection) State.keepSelection = true;
    el.focus();
    if (cursor === 'end') setCursor(el, true);
    if (cursor === 'start') setCursor(el, false);
    if (preserveSelection) queueMicrotask(() => { State.keepSelection = false; });
    return true;
}

function focusZoomDesc() {
    State.focusedId = null;
    zoomDescEl?.focus();
}

function focusBoundary(edge, fallback) {
    const flat = flatVisible(State.getZoomRoot());
    const target = edge === 'first' ? flat[0]?.node.id : flat[flat.length - 1]?.node.id;
    if (target) {
        focusBullet(target, edge === 'first' ? 'start' : 'end');
        return true;
    }
    if (fallback === 'ghost') focusGhostText();
    if (fallback === 'zoom' && State.zoomStack.length > 0) focusZoomDesc();
    return false;
}

function focusPrev(id) {
    const flat = flatVisible(State.getZoomRoot());
    const idx = flat.findIndex(entry => entry.node.id === id);
    if (idx <= 0) {
        if (State.zoomStack.length > 0) focusZoomDesc();
        return;
    }
    focusBullet(flat[idx - 1].node.id);
}

function focusNext(id) {
    const flat = flatVisible(State.getZoomRoot());
    const idx = flat.findIndex(entry => entry.node.id === id);
    if (idx === -1) return;
    if (idx >= flat.length - 1) {
        focusGhostText();
        return;
    }
    focusBullet(flat[idx + 1].node.id, 'start');
}

function focusRowText(row) {
    row?.querySelector(BULLET_TEXT)?.focus();
}

function getRowAndNode(target) {
    const row = target.closest('.bullet-row');
    if (!row) return { row: null, id: null, node: null };
    const id = row.dataset.id;
    return { row, id, node: findNode(id, State.doc.root) };
}

async function closeTopLayer() {
    if (State.activeModal) {
        await dispatch({ type: 'CLOSE_MODAL', id: State.activeModal });
        return true;
    }
    if (State.searchOpen) {
        await dispatch({ type: 'CLOSE_SEARCH' });
        return true;
    }
    const visibleModal = [...document.querySelectorAll('.modal-overlay')].find((modal) => !modal.classList.contains('hidden'));
    if (visibleModal) {
        visibleModal.classList.add('hidden');
        return true;
    }
    return false;
}

function startSyncLoop() {
    if (!State.encryptionKey || State.syncIntervalId) return;
    State.syncIntervalId = setInterval(() => {
        void dispatch({ type: 'SYNC_REQUEST' });
    }, State.SYNC_INTERVAL_MS);
}

function stopSyncLoop() {
    if (State.syncIntervalId) {
        clearInterval(State.syncIntervalId);
        State.syncIntervalId = null;
    }
}

async function runEffect(effect) {
    switch (effect.type) {
        case 'focus-bullet':
            requestAnimationFrame(() => focusBullet(effect.id, effect.cursor));
            return;

        case 'focus-ghost':
            requestAnimationFrame(() => focusGhostText());
            return;

        case 'focus-zoom-desc':
            requestAnimationFrame(() => {
                if (!('ontouchstart' in window)) focusZoomDesc();
            });
            return;

        case 'focus-search':
            requestAnimationFrame(() => byId('search-input')?.focus());
            return;

        case 'focus-markdown':
            requestAnimationFrame(() => byId('markdown-text')?.focus());
            return;

        case 'scroll-match':
            requestAnimationFrame(() => {
                const id = State.searchMatches[State.searchIdx];
                document.querySelector(`.bullet-row[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            return;

        case 'copy-markdown':
            try {
                await navigator.clipboard.writeText(effect.text);
            } catch {
                showToast('Copy failed');
            }
            return;

        case 'toast':
            showToast(effect.message);
            return;

        case 'confirm-delete':
            if (window.confirm(effect.message)) {
                await dispatch({ type: 'CONFIRMED_DELETE', ids: effect.ids });
            }
            return;

        case 'login-submit': {
            const result = await submitLogin(effect.payload);
            await dispatch({ type: 'LOGIN_RESULT', result });
            return;
        }

        case 'sign-out':
            await performSignOut();
            await dispatch({ type: 'SIGNED_OUT' });
            return;

        case 'delete-account':
            try {
                await performDeleteAccount();
                await dispatch({ type: 'SIGNED_OUT' });
            } catch {
                await dispatch({ type: 'DELETE_ACCOUNT_FAILED' });
            }
            return;

        case 'sync-now': {
            const result = await syncNow(syncSnapshot());
            await dispatch({ type: 'SYNC_RESULT', result });
            return;
        }

        case 'push-resolved-doc': {
            const result = await pushResolvedDoc(syncSnapshot(), effect.baseServerVersion);
            await dispatch({ type: 'SYNC_RESULT', result });
            return;
        }

        case 'start-sync-loop':
            startSyncLoop();
            return;

        case 'stop-sync-loop':
            stopSyncLoop();
            return;

        case 'schedule-online':
            window.setTimeout(() => {
                if (State.syncStatus === 'synced') void dispatch({ type: 'SYNC_ONLINE' });
            }, 3000);
            return;

        case 'push-hash':
            history.pushState(null, '', effect.hash);
            return;

        case 'replace-hash':
            history.replaceState(null, '', effect.hash);
            return;

        default:
            return;
    }
}

async function dispatch(msg, options = {}) {
    const { render: shouldRender = true } = options;
    const { effects = [] } = update(msg);
    if (shouldRender) renderApp();
    if (!shouldRender) applySelectionHighlights();
    for (const effect of effects) await runEffect(effect);
}

function handleBulletKey(event, node) {
    const target = event.target;
    const draftText = target.textContent ?? node.text;

    const handlers = [
        [
            (current) => isPlainKey(current, 'Escape'),
            async (current) => {
                await dispatch({ type: 'CLEAR_SELECTION' }, { render: false });
                current.target.blur();
            }
        ],
        [
            (current) => current.shiftKey && (isArrowKey(current, 'ArrowUp') || isArrowKey(current, 'ArrowDown')),
            async (current) => {
                await dispatch({
                    type: 'EXTEND_SELECTION',
                    id: node.id,
                    dir: current.key === 'ArrowUp' ? -1 : 1,
                }, { render: false });
                State.keepSelection = true;
                focusBullet(State.selectionHead);
                State.keepSelection = false;
            }
        ],
        [
            (current) => current.shiftKey && current.key === 'Enter',
            async () => {
                const row = document.querySelector(`.bullet-row[data-id="${node.id}"]`);
                if (row) {
                    showDescEditor(row);
                    row.querySelector('.bullet-desc')?.focus();
                }
            }
        ],
        [
            (current) => isCmdKey(current, ' '),
            async () => {
                if (node.children.length > 0) await dispatch({ type: 'TOGGLE_COLLAPSE', id: node.id });
            }
        ],
        [
            (current) => current.altKey && current.key === 'ArrowRight',
            async () => dispatch({ type: 'ZOOM_IN', id: node.id, text: draftText })
        ],
        [
            (current) => current.altKey && current.key === 'ArrowLeft',
            async () => dispatch({ type: 'ZOOM_OUT' })
        ],
        [
            (current) => current.altKey && (current.key === 'ArrowUp' || current.key === 'ArrowDown'),
            async (current) => dispatch({
                type: 'MOVE_TARGET',
                id: node.id,
                text: draftText,
                dir: current.key === 'ArrowUp' ? -1 : 1,
            })
        ],
        [
            (current) => current.key === 'Tab',
            async (current) => dispatch({
                type: current.shiftKey ? 'UNINDENT_TARGET' : 'INDENT_TARGET',
                id: node.id,
                text: draftText,
            })
        ],
        [
            (current) => isPlainKey(current, 'Enter'),
            async () => dispatch({ type: 'CREATE_AFTER', id: node.id, text: draftText })
        ],
        [
            (current) => isCmdKey(current, 'Backspace'),
            async () => dispatch({ type: 'DELETE_TARGET', id: node.id, text: draftText })
        ],
        [
            (current) => isCmdKey(current, 'c') && State.selectedIds.length > 1,
            async () => dispatch({ type: 'COPY_SELECTION' })
        ],
        [
            (current) => current.key === 'Backspace' && draftText === '' && node.description === '',
            async () => dispatch({ type: 'DELETE_TARGET', id: node.id, text: draftText })
        ],
        [
            (current) => isArrowNoMods(current, 'ArrowUp') || isArrowNoMods(current, 'ArrowDown'),
            async (current) => {
                await dispatch({ type: 'CLEAR_SELECTION' }, { render: false });
                current.key === 'ArrowUp' ? focusPrev(node.id) : focusNext(node.id);
            }
        ],
        [
            (current) => current.key === '?' && !current.ctrlKey && !current.metaKey && !current.altKey && draftText === '',
            async () => dispatch({ type: 'OPEN_MODAL', id: 'modal-shortcuts' })
        ],
        [
            (current) => isCmdKey(current, 'f'),
            async () => dispatch({ type: 'OPEN_SEARCH' })
        ],
        [
            (current) => isCmdKey(current, 'z'),
            async () => dispatch({ type: 'UNDO' })
        ],
    ];

    for (const [matches, action] of handlers) {
        if (!matches(event)) continue;
        event.preventDefault();
        void action(event);
        return;
    }
}

bulletsEl.addEventListener('focusin', (event) => {
    const target = event.target;

    if (target.matches(BULLET_TEXT)) {
        const id = target.dataset.id;
        const node = findNode(id, State.doc.root);
        if (!node) return;
        if (!State.keepSelection) {
            void dispatch({ type: 'CLEAR_SELECTION' }, { render: false });
        }
        State.focusedId = id;
        target.closest('.bullet-row')?.classList.add('focused');
        target.textContent = node.text;
        beginEdit(target, node.text);
        setCursor(target, true);
        return;
    }

    if (target.id === 'ghost-text') {
        if (!State.keepSelection) {
            void dispatch({ type: 'CLEAR_SELECTION' }, { render: false });
        }
        State.focusedId = null;
        target.closest('.ghost-row')?.classList.add('focused');
        return;
    }

    if (target.matches(BULLET_DESC)) {
        const { row, id, node } = getRowAndNode(target);
        if (!row || !node) return;
        State.focusedId = id;
        beginEdit(target, node.description || '');
        showDescEditor(row);
    }
});

bulletsEl.addEventListener('focusout', (event) => {
    const target = event.target;

    if (target.matches(BULLET_TEXT)) {
        target.closest('.bullet-row')?.classList.remove('focused');
        const changed = endEdit(target);
        const rawText = target.textContent ?? '';
        target.innerHTML = renderInline(rawText);
        void dispatch({
            type: 'COMMIT_BULLET_TEXT',
            id: target.dataset.id,
            text: rawText,
            changed,
        }, { render: changed });
        return;
    }

    if (target.id === 'ghost-text') {
        target.closest('.ghost-row')?.classList.remove('focused');
        const text = target.textContent ?? '';
        void dispatch({ type: 'APPEND_GHOST', text }, { render: !!text.trim() });
        target.textContent = '';
        return;
    }

    if (target.matches(BULLET_DESC)) {
        const { row, id, node } = getRowAndNode(target);
        if (!row || !id) return;
        target.classList.remove('editing');
        const changed = endEdit(target);
        if (node) renderDescView(row, node);
        void dispatch({
            type: 'COMMIT_BULLET_DESC',
            id,
            text: target.value,
            changed,
        }, { render: changed });
    }
});

bulletsEl.addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches(BULLET_TEXT)) {
        touchEdit(target, target.textContent ?? '');
        return;
    }
    if (target.matches(BULLET_DESC)) {
        touchEdit(target, target.value);
        autoResize(target);
    }
});

bulletsEl.addEventListener('keydown', (event) => {
    const target = event.target;

    if (target.matches(BULLET_TEXT)) {
        const node = findNode(target.dataset.id, State.doc.root);
        if (node) handleBulletKey(event, node);
        return;
    }

    if (target.id === 'ghost-text') {
        if (isPlainKey(event, 'Enter')) {
            event.preventDefault();
            target.blur();
            requestAnimationFrame(() => focusGhostText());
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            target.textContent = '';
            target.blur();
        }
        if (isArrowNoMods(event, 'ArrowUp')) {
            event.preventDefault();
            focusBoundary('last', 'zoom');
        }
        if (event.key === 'Backspace' && !(target.textContent || '').trim()) {
            event.preventDefault();
            requestAnimationFrame(() => focusBoundary('last', 'zoom'));
        }
        return;
    }

    if (target.matches(BULLET_DESC)) {
        if (event.key === 'Escape' || (event.shiftKey && event.key === 'Enter')) {
            event.preventDefault();
            const row = target.closest('.bullet-row');
            const id = row?.dataset.id;
            target.blur();
            requestAnimationFrame(() => {
                if (id) focusBullet(id);
                else focusRowText(row);
            });
        }
        if (isCmdKey(event, 'f')) {
            event.preventDefault();
            void dispatch({ type: 'OPEN_SEARCH' });
        }
    }
});

bulletsEl.addEventListener('click', (event) => {
    const target = event.target;

    if (target === bulletsEl) {
        focusBoundary('last');
        return;
    }

    if (target.matches('.collapse-toggle.active')) {
        event.stopPropagation();
        const { id } = getRowAndNode(target);
        if (id) void dispatch({ type: 'TOGGLE_COLLAPSE', id });
        return;
    }

    if (target.matches('.bullet-dot')) {
        event.stopPropagation();
        const { id, node } = getRowAndNode(target);
        if (id && node) void dispatch({ type: 'ZOOM_IN', id, text: node.text });
        return;
    }

    if (target.matches('.bullet-desc-view')) {
        const row = target.closest('.bullet-row');
        if (!row) return;
        showDescEditor(row);
        row.querySelector('.bullet-desc')?.focus();
        return;
    }

    if (target.id === 'ghost-row' || (target !== bulletsEl && target.closest('#ghost-row'))) {
        const ghostText = byId('ghost-text');
        if (ghostText && target !== ghostText) focusGhostText();
    }
});

bulletsEl.addEventListener('touchstart', (event) => {
    const row = event.target.closest('.bullet-row');
    if (!row) return;
    row.dataset.touchStartX = event.touches[0].clientX;
    row.dataset.touchStartY = event.touches[0].clientY;
}, { passive: true });

bulletsEl.addEventListener('touchend', (event) => {
    const row = event.target.closest('.bullet-row');
    if (!row) return;
    const dx = event.changedTouches[0].clientX - (row.dataset.touchStartX || 0);
    const dy = event.changedTouches[0].clientY - (row.dataset.touchStartY || 0);
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 2) {
        void dispatch({
            type: dx > 0 ? 'INDENT_TARGET' : 'UNINDENT_TARGET',
            id: row.dataset.id,
            text: findNode(row.dataset.id, State.doc.root)?.text || '',
            noFocus: true,
        });
    }
}, { passive: true });

bulletsEl.addEventListener('pointerdown', (event) => {
    const link = event.target.closest('a');
    const bulletText = event.target.closest(BULLET_TEXT);
    if (link && bulletText && document.activeElement !== bulletText) {
        window.open(link.href, '_blank', 'noopener,noreferrer');
        event.preventDefault();
    }
});

breadcrumbEl?.addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-zoom-depth]');
    if (!crumb) return;
    const depth = Number.parseInt(crumb.dataset.zoomDepth, 10);
    if (Number.isInteger(depth)) void dispatch({ type: 'ZOOM_TO', stack: State.zoomStack.slice(0, depth) });
});

zoomDescEl.addEventListener('blur', () => {
    const changed = endEdit(zoomDescEl);
    void dispatch({
        type: 'COMMIT_ZOOM_DESC',
        text: zoomDescEl.textContent ?? '',
        changed,
    }, { render: changed });
});

zoomDescEl.addEventListener('focus', () => {
    if (State.zoomStack.length > 0) beginEdit(zoomDescEl, State.getZoomRoot().description || '');
});

zoomDescEl.addEventListener('input', () => {
    touchEdit(zoomDescEl, zoomDescEl.textContent ?? '');
});

zoomDescEl.addEventListener('keydown', (event) => {
    if (isArrowNoMods(event, 'ArrowDown')) {
        event.preventDefault();
        focusBoundary('first', 'ghost');
        return;
    }
    if (event.shiftKey && event.key === 'Enter') {
        event.preventDefault();
        zoomDescEl.blur();
        focusBoundary('first', 'ghost');
        return;
    }
    if ((event.altKey && event.key === 'ArrowLeft') || event.key === 'Escape') {
        event.preventDefault();
        zoomDescEl.blur();
        void dispatch({ type: 'ZOOM_OUT' });
        return;
    }
    if (isCmdKey(event, 'f')) {
        event.preventDefault();
        void dispatch({ type: 'OPEN_SEARCH' });
    }
});

document.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    const isEditing = active && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

    if (event.key === 'Escape') {
        void closeTopLayer();
        if (State.activeModal || State.searchOpen) return;
    }

    if (!isEditing) {
        if (isPlainKey(event, 'Enter') && !event.defaultPrevented) {
            event.preventDefault();
            focusGhostText();
            return;
        }
        if (event.key === '?') {
            event.preventDefault();
            void dispatch({ type: 'OPEN_MODAL', id: 'modal-shortcuts' });
            return;
        }
        if (isCmdKey(event, 'f')) {
            event.preventDefault();
            void dispatch({ type: 'OPEN_SEARCH' });
            return;
        }
        if (isCmdKey(event, 'z')) {
            event.preventDefault();
            void dispatch({ type: 'UNDO' });
            return;
        }
        if (isArrowNoMods(event, 'ArrowDown') || isArrowNoMods(event, 'ArrowUp')) {
            if (focusBoundary(event.key === 'ArrowDown' ? 'first' : 'last')) event.preventDefault();
        }
    }
});

document.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
        const action = actionEl.dataset.action;

        if (action === 'apply-markdown') {
            void dispatch({ type: 'APPLY_MARKDOWN_IMPORT', text: byId('markdown-text').value });
            return;
        }
        if (action === 'close-search') {
            void dispatch({ type: 'CLOSE_SEARCH' });
            return;
        }
        if (action === 'conflict-apply') {
            void dispatch({ type: 'CONFLICT_APPLY', text: byId('conflict-resolved').value });
            return;
        }
        if (action === 'conflict-use-local') {
            void dispatch({ type: 'CONFLICT_USE_LOCAL' });
            return;
        }
        if (action === 'conflict-use-remote') {
            void dispatch({ type: 'CONFLICT_USE_REMOTE' });
            return;
        }
        if (action === 'delete-account') {
            if (window.confirm('Delete your account? This will permanently remove all synced data and cannot be undone.')) {
                void dispatch({ type: 'DELETE_ACCOUNT_REQUEST' });
            }
            return;
        }
        if (action === 'open-markdown') {
            void dispatch({ type: 'OPEN_MARKDOWN_MODAL' });
            return;
        }
        if (action === 'open-options') {
            void dispatch({ type: 'OPEN_MODAL', id: 'modal-options' });
            return;
        }
        if (action === 'open-shortcuts') {
            void dispatch({ type: 'OPEN_MODAL', id: 'modal-shortcuts' });
            return;
        }
        if (action === 'sign-in') {
            void dispatch({ type: 'OPEN_LOGIN_MODAL' });
            return;
        }
        if (action === 'sign-out') {
            void dispatch({ type: 'SIGN_OUT_REQUEST' });
            return;
        }
        if (action === 'submit-login') {
            const email = byId('login-email').value.trim();
            const password = byId('login-password').value;
            const confirmPassword = byId('login-confirm-password')?.value || '';
            if (State.loginMode === 'signin' && email && password && State.doc.root.children.length > 0) {
                if (!window.confirm('Signing in will replace your local data with the server version. Continue?')) return;
            }
            void dispatch({
                type: 'LOGIN_REQUEST',
                payload: { email, password, confirmPassword, mode: State.loginMode },
            });
            return;
        }
        if (action === 'switch-login-mode') {
            void dispatch({ type: 'TOGGLE_LOGIN_MODE' });
            return;
        }
        if (action === 'toggle-dev') {
            State.devMode = !State.devMode;
            localStorage.setItem(State.DEV_MODE_KEY, String(State.devMode));
            renderApp();
            return;
        }
        if (action === 'toggle-theme') {
            const next = (document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark';
            localStorage.setItem(State.THEME_KEY, next);
            applyTheme(next);
            return;
        }
    }

    const closeEl = event.target.closest('.modal-close, [data-modal]');
    if (closeEl) {
        const modal = closeEl.dataset.modal || closeEl.closest('.modal-overlay')?.id;
        if (modal) void dispatch({ type: 'CLOSE_MODAL', id: modal });
        return;
    }

    const overlay = event.target.closest('.modal-overlay');
    if (overlay && event.target === overlay) void dispatch({ type: 'CLOSE_MODAL', id: overlay.id });
});

window.addEventListener('popstate', () => {
    void dispatch({ type: 'RESTORE_HASH' });
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && State.syncIntervalId) void dispatch({ type: 'SYNC_REQUEST' });
});

on('search-input', 'input', (event) => {
    void dispatch({ type: 'SEARCH_QUERY_CHANGED', query: event.target.value });
});

on('search-input', 'keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        void dispatch({ type: 'SEARCH_NEXT' });
    }
    if (event.key === 'Escape') void dispatch({ type: 'CLOSE_SEARCH' });
});

on('markdown-text', 'input', (event) => {
    void dispatch({ type: 'UPDATE_MARKDOWN_DRAFT', text: event.target.value }, { render: false });
});

on('conflict-resolved', 'input', (event) => {
    void dispatch({ type: 'CONFLICT_UPDATE_RESOLVED', text: event.target.value }, { render: false });
});

async function init() {
    applyTheme(localStorage.getItem(State.THEME_KEY) || 'light');
    await dispatch({ type: 'INIT_LOCAL_DOC' });
    registerAuthListener((session) => {
        void dispatch({ type: 'AUTH_SESSION_CHANGED', user: session?.user || null }, { render: true });
    });
    renderApp();
    await dispatch({ type: 'AUTH_READY', result: await initAuth() });

    const splash = byId('splash');
    if (splash && !splash.classList.contains('hidden')) {
        setTimeout(() => {
            splash.classList.add('fade-out');
            setTimeout(() => splash.classList.add('hidden'), 700);
        }, 400);
    }
}

init();
