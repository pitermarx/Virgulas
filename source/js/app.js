// ── App ───────────────────────────────────────────────────────────────────────
// Entry point: DOM events in, update/view/sync calls out.

import { findNode, flatVisible, renderInline, exportMarkdown, seedDoc } from './model.js';
import State from './state.js';
import {
    render, setSyncStatus, applyDevMode, applyTheme, openModal, closeModal, openSearch,
    setLoginMode, loginMode, setZoomToCallback, showDescEditor, renderDescView, autoResize,
    updateStorageIndicator, byId, setCursor
} from './view.js';
import {
    focusNode, focusNodeAtStart, clearSelection,
    zoomInto, zoomOut, zoomTo, undo,
    indentNode, unindentNode, appendGhostBullet, toggleCollapse,
    handleBulletKey, doSearch, nextMatch, endSearch, applyMarkdownImport
} from './update.js';
import {
    initAuth, handleLoginSubmit, syncNow, signOut, deleteAccount,
    handleConflictUseLocal, handleConflictUseRemote, handleConflictApply
} from './sync.js';
import { isCmdKey, isPlainKey, isArrowNoMods } from './keys.js';

// ── Wire callbacks ────────────────────────────────────────────────────────────

setZoomToCallback(zoomTo);
State.onSyncStatusUpdate = setSyncStatus;
State.onDocSaved = updateStorageIndicator;

// ── Helpers ───────────────────────────────────────────────────────────────────

const bulletsEl = byId('bullets');
const zoomDescEl = byId('zoom-desc');
const MODAL_IDS = ['modal-login', 'modal-conflict', 'modal-markdown', 'modal-shortcuts', 'modal-options'];
const EDIT_STATE = new WeakMap();
const BULLET_TEXT = '.bullet-text[data-id]';
const BULLET_DESC = '.bullet-desc';

function on(id, event, handler) { byId(id)?.addEventListener(event, handler); }

function focusGhostText() { byId('ghost-text')?.focus(); }

function focusBoundary(edge, fallback) {
    const flat = flatVisible(State.getZoomRoot());
    const target = edge === 'first' ? flat[0]?.node.id : flat[flat.length - 1]?.node.id;
    if (target) {
        edge === 'first' ? focusNodeAtStart(target) : focusNode(target);
        return true;
    }
    if (fallback === 'ghost') focusGhostText();
    if (fallback === 'zoom' && State.zoomStack.length > 0) zoomDescEl?.focus();
    return false;
}

function getRowAndNode(target) {
    const row = target.closest('.bullet-row');
    if (!row) return { row: null, id: null, node: null };
    const id = row.dataset.id;
    return { row, id, node: findNode(id, State.doc.root) };
}

function closeTopLayer() {
    for (const id of MODAL_IDS) {
        const modal = byId(id);
        if (modal && !modal.classList.contains('hidden')) { closeModal(id); return true; }
    }
    if (byId('search-bar')?.classList.contains('visible')) { endSearch(); return true; }
    return false;
}

// ── Bullet container delegation ───────────────────────────────────────────────

function beginEdit(target, value) {
    EDIT_STATE.set(target, { value, changed: false });
}

function touchEdit(target, value) {
    const session = EDIT_STATE.get(target);
    if (!session) return false;
    if (!session.changed && value !== session.value) {
        State.pushUndo();
        session.changed = true;
    }
    return session.changed;
}

function endEdit(target) {
    const session = EDIT_STATE.get(target);
    EDIT_STATE.delete(target);
    return !!session?.changed;
}

function focusRowText(row) {
    row?.querySelector(BULLET_TEXT)?.focus();
}

const clickActions = {
    'apply-markdown': () => {
        applyMarkdownImport(byId('markdown-text').value);
        closeModal('modal-markdown');
    },
    'close-search': endSearch,
    'conflict-apply': () => handleConflictApply(byId('conflict-resolved').value),
    'conflict-use-local': handleConflictUseLocal,
    'conflict-use-remote': handleConflictUseRemote,
    'delete-account': deleteAccount,
    'open-markdown': () => {
        byId('markdown-text').value = exportMarkdown(State.doc.root).trim();
        openModal('modal-markdown');
        setTimeout(() => byId('markdown-text').focus(), 50);
    },
    'open-options': () => openModal('modal-options'),
    'open-shortcuts': () => openModal('modal-shortcuts'),
    'sign-in': () => {
        setLoginMode('signin');
        openModal('modal-login');
    },
    'sign-out': signOut,
    'submit-login': () => handleLoginSubmit(loginMode),
    'switch-login-mode': () => setLoginMode(loginMode === 'signin' ? 'signup' : 'signin'),
    'toggle-dev': () => {
        State.devMode = !State.devMode;
        localStorage.setItem(State.DEV_MODE_KEY, String(State.devMode));
        applyDevMode();
    },
    'toggle-theme': () => {
        const next = (document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark';
        localStorage.setItem(State.THEME_KEY, next);
        applyTheme(next);
    },
};

bulletsEl.addEventListener('focusin', (e) => {
    const target = e.target;

    if (target.matches(BULLET_TEXT)) {
        const id = target.dataset.id;
        const node = findNode(id, State.doc.root);
        if (!node) return;
        if (!State.keepSelection) clearSelection();
        State.focusedId = id;
        target.closest('.bullet-row').classList.add('focused');
        target.textContent = node.text;
        beginEdit(target, node.text);
        setCursor(target, true);
        return;
    }

    if (target.id === 'ghost-text') {
        if (!State.keepSelection) clearSelection();
        State.focusedId = null;
        target.closest('.ghost-row').classList.add('focused');
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

bulletsEl.addEventListener('focusout', (e) => {
    const target = e.target;

    if (target.matches(BULLET_TEXT)) {
        const node = findNode(target.dataset.id, State.doc.root);
        target.closest('.bullet-row')?.classList.remove('focused');
        if (node) {
            node.text = target.textContent;
            target.innerHTML = renderInline(node.text);
            if (endEdit(target)) State.saveDoc();
        }
        return;
    }

    if (target.id === 'ghost-text') {
        target.closest('.ghost-row')?.classList.remove('focused');
        appendGhostBullet(target.textContent);
        target.textContent = '';
        return;
    }

    if (target.matches(BULLET_DESC)) {
        const { row, node } = getRowAndNode(target);
        if (!row) return;
        target.classList.remove('editing');
        if (node) renderDescView(row, node);
        if (endEdit(target)) State.saveDoc();
    }
});

bulletsEl.addEventListener('input', (e) => {
    const target = e.target;

    if (target.matches(BULLET_TEXT)) {
        const node = findNode(target.dataset.id, State.doc.root);
        if (node) {
            node.text = target.textContent;
            touchEdit(target, node.text);
        }
        return;
    }

    if (target.matches(BULLET_DESC)) {
        const { node } = getRowAndNode(target);
        if (node) node.description = target.value;
        touchEdit(target, target.value);
        autoResize(target);
    }
});

bulletsEl.addEventListener('keydown', (e) => {
    const target = e.target;

    if (target.matches(BULLET_TEXT)) {
        const node = findNode(target.dataset.id, State.doc.root);
        if (node) handleBulletKey(e, node);
        return;
    }

    if (target.id === 'ghost-text') {
        if (isPlainKey(e, 'Enter')) {
            e.preventDefault(); target.blur(); requestAnimationFrame(focusGhostText);
        }
        if (e.key === 'Escape') {
            e.preventDefault(); target.textContent = ''; target.blur();
        }
        if (isArrowNoMods(e, 'ArrowUp') || (e.key === 'Backspace' && target.textContent === '')) {
            e.preventDefault(); focusBoundary('last', 'zoom');
        }
        return;
    }

    if (target.matches(BULLET_DESC)) {
        if (e.key === 'Escape' || (e.shiftKey && e.key === 'Enter')) {
            e.preventDefault(); target.blur();
            focusRowText(target.closest('.bullet-row'));
        }
        if (isCmdKey(e, 'f')) { e.preventDefault(); openSearch(); }
    }
});

bulletsEl.addEventListener('click', (e) => {
    const target = e.target;

    if (target === bulletsEl) {
        focusBoundary('last');
        return;
    }

    if (target.matches('.collapse-toggle.active')) {
        e.stopPropagation();
        const { id } = getRowAndNode(target);
        if (id) toggleCollapse(id);
        return;
    }

    if (target.matches('.bullet-dot')) {
        e.stopPropagation();
        const { id } = getRowAndNode(target);
        if (id) zoomInto(id);
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
        if (ghostText && target !== ghostText) ghostText.focus();
    }
});

bulletsEl.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.bullet-row');
    if (row) {
        row.dataset.touchStartX = e.touches[0].clientX;
        row.dataset.touchStartY = e.touches[0].clientY;
    }
}, { passive: true });

bulletsEl.addEventListener('touchend', (e) => {
    const row = e.target.closest('.bullet-row');
    if (row) {
        const dx = e.changedTouches[0].clientX - (row.dataset.touchStartX || 0);
        const dy = e.changedTouches[0].clientY - (row.dataset.touchStartY || 0);
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 2) {
            if (dx > 0) indentNode(row.dataset.id, true);
            else unindentNode(row.dataset.id, true);
        }
    }
}, { passive: true });

bulletsEl.addEventListener('pointerdown', (e) => {
    const link = e.target.closest('a');
    const bulletText = e.target.closest(BULLET_TEXT);
    if (link && bulletText && document.activeElement !== bulletText) {
        window.open(link.href, '_blank', 'noopener,noreferrer');
        e.preventDefault();
    }
});

// ── Zoom desc ─────────────────────────────────────────────────────────────────

zoomDescEl.addEventListener('blur', () => {
    const zoomRoot = State.getZoomRoot();
    if (zoomRoot && State.zoomStack.length > 0) {
        const newDesc = zoomDescEl.textContent;
        if (newDesc !== (zoomRoot.description || '')) {
            zoomRoot.description = newDesc;
            if (endEdit(zoomDescEl)) State.saveDoc();
            return;
        }
    }
    endEdit(zoomDescEl);
});

zoomDescEl.addEventListener('focus', () => {
    if (State.zoomStack.length > 0) beginEdit(zoomDescEl, State.getZoomRoot().description || '');
});

zoomDescEl.addEventListener('input', () => {
    touchEdit(zoomDescEl, zoomDescEl.textContent);
});

zoomDescEl.addEventListener('keydown', (e) => {
    if (isArrowNoMods(e, 'ArrowDown')) {
        e.preventDefault(); focusBoundary('first', 'ghost'); return;
    }
    if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault(); zoomDescEl.blur(); focusBoundary('first', 'ghost'); return;
    }
    if ((e.altKey && e.key === 'ArrowLeft') || e.key === 'Escape') {
        e.preventDefault(); zoomDescEl.blur(); zoomOut(); return;
    }
    if (isCmdKey(e, 'f')) { e.preventDefault(); openSearch(); }
});

// ── Global key handler ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isEditing = active && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

    if (e.key === 'Escape') { if (closeTopLayer()) return; }

    if (!isEditing) {
        if (isPlainKey(e, 'Enter') && !e.defaultPrevented) { e.preventDefault(); focusGhostText(); return; }
        if (e.key === '?') { e.preventDefault(); openModal('modal-shortcuts'); return; }
        if (isCmdKey(e, 'f')) { e.preventDefault(); openSearch(); return; }
        if (isCmdKey(e, 'z')) { e.preventDefault(); undo(); return; }
        if (isArrowNoMods(e, 'ArrowDown') || isArrowNoMods(e, 'ArrowUp')) {
            if (focusBoundary(e.key === 'ArrowDown' ? 'first' : 'last')) e.preventDefault();
            return;
        }
    }
});

document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
        clickActions[actionEl.dataset.action]?.();
        return;
    }

    const closeEl = e.target.closest('.modal-close, [data-modal]');
    if (closeEl) {
        const modal = closeEl.dataset.modal || closeEl.closest('.modal-overlay')?.id;
        if (modal) closeModal(modal);
        return;
    }

    const overlay = e.target.closest('.modal-overlay');
    if (overlay && e.target === overlay) closeModal(overlay.id);
});

// ── URL / history (popstate means back/forward navigation or manual hash change) 

window.addEventListener('popstate', () => { State.loadFromHash(); render(); });

// ── Visibility ────────────────────────────────────────────────────────────────

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && State.syncIntervalId) syncNow();
});

// ── Search ────────────────────────────────────────────────────────────────────

on('search-input', 'input', (e) => doSearch(e.target.value));
on('search-input', 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextMatch(); }
    if (e.key === 'Escape') endSearch();
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
    applyTheme(localStorage.getItem(State.THEME_KEY) || 'light');
    if (!State.loadDoc()) { seedDoc(State.doc); State.saveDocLocal(); }
    State.loadFromHash();
    render();
    updateStorageIndicator();
    initAuth();
    applyDevMode();

    const splash = byId('splash');
    if (splash && !splash.classList.contains('hidden')) {
        setTimeout(() => {
            splash.classList.add('fade-out');
            setTimeout(() => splash.classList.add('hidden'), 700);
        }, 400);
    }
}

init();
