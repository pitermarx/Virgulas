// ── App ───────────────────────────────────────────────────────────────────────
// Entry point: initialises the app and wires up all DOM event listeners.
// Events are handled via delegation on container elements where possible,
// following the Elm-inspired architecture (view is pure; update handles events).

import { makeNode, findNode, flatVisible, renderInline, exportMarkdown, seedDoc } from './model.js';
import * as State from './state.js';
import {
    render, setSyncStatus, renderSyncToggle, applyDevMode,
    applyTheme, openModal, closeModal, openSearch,
    setLoginMode, loginMode, setZoomToCallback, showDescEditor, autoResize,
    renderBreadcrumb
} from './view.js';
import {
    focusNode, focusNodeAtStart, clearSelection, applySelectionHighlights,
    zoomInto, zoomOut, zoomTo, undo,
    newBulletAfter, deleteNode, indentNode, unindentNode,
    handleBulletKey, doSearch, nextMatch, endSearch, applyMarkdownImport
} from './update.js';
import {
    initAuth, handleLoginSubmit, startSync, stopSync, syncNow,
    getActiveSession, handleConflictUseLocal, handleConflictUseRemote, handleConflictApply
} from './sync.js';

// ── Register zoom callback in view ────────────────────────────────────────────

setZoomToCallback(zoomTo);
State.setSyncStatusCallback(setSyncStatus);

// ── Bullet container delegation ───────────────────────────────────────────────

const bulletsEl = document.getElementById('bullets');
let _preFocusText = null;

bulletsEl.addEventListener('focusin', (e) => {
    const target = e.target;

    if (target.matches('.bullet-text[data-id]')) {
        const id = target.dataset.id;
        const node = findNode(id, State.doc.root);
        if (!node) return;
        if (!State._keepSelection) clearSelection();
        State.setFocusedId(id);
        target.closest('.bullet-row').classList.add('focused');
        target.textContent = node.text;
        _preFocusText = node.text;
        State.pushUndo();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
    }

    if (target.id === 'ghost-text') {
        if (!State._keepSelection) clearSelection();
        State.setFocusedId(null);
        target.closest('.ghost-row').classList.add('focused');
        return;
    }

    if (target.matches('.bullet-desc')) {
        const row = target.closest('.bullet-row');
        if (!row) return;
        const id = row.dataset.id;
        const node = findNode(id, State.doc.root);
        if (!node) return;
        State.setFocusedId(id);
        State.pushUndo();
        showDescEditor(row);
    }
});

bulletsEl.addEventListener('focusout', (e) => {
    const target = e.target;

    if (target.matches('.bullet-text[data-id]')) {
        const id = target.dataset.id;
        const node = findNode(id, State.doc.root);
        target.closest('.bullet-row')?.classList.remove('focused');
        if (node) {
            node.text = target.textContent;
            target.innerHTML = renderInline(node.text);
            if (node.text !== _preFocusText) {
                State.saveDoc();
            }
            _preFocusText = null;
        }
        return;
    }

    if (target.id === 'ghost-text') {
        target.closest('.ghost-row')?.classList.remove('focused');
        const text = target.textContent.trim();
        if (text) {
            const newNode = makeNode(text);
            State.pushUndo();
            State.getZoomRoot().children.push(newNode);
            State.saveDoc();
            target.textContent = '';
            render();
        } else {
            target.textContent = '';
        }
        return;
    }

    if (target.matches('.bullet-desc')) {
        const row = target.closest('.bullet-row');
        if (!row) return;
        const id = row.dataset.id;
        const node = findNode(id, State.doc.root);
        target.classList.remove('editing');
        if (node) {
            const descView = row.querySelector('.bullet-desc-view');
            descView.textContent = node.description || '';
            if (node.description) {
                descView.classList.add('visible');
            } else {
                descView.classList.remove('visible');
            }
        }
    }
});

bulletsEl.addEventListener('input', (e) => {
    const target = e.target;

    if (target.matches('.bullet-text[data-id]')) {
        const id = target.dataset.id;
        const node = findNode(id, State.doc.root);
        if (node) node.text = target.textContent;
        return;
    }

    if (target.matches('.bullet-desc')) {
        const row = target.closest('.bullet-row');
        if (!row) return;
        const id = row.dataset.id;
        const node = findNode(id, State.doc.root);
        if (node) node.description = target.value;
        autoResize(target);
        State.saveDoc();
    }
});

bulletsEl.addEventListener('keydown', (e) => {
    const target = e.target;

    if (target.matches('.bullet-text[data-id]')) {
        const id = target.dataset.id;
        const node = findNode(id, State.doc.root);
        if (node) handleBulletKey(e, node);
        return;
    }

    if (target.id === 'ghost-text') {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            target.blur();
            requestAnimationFrame(() => {
                const ghostText = document.getElementById('ghost-text');
                if (ghostText) ghostText.focus();
            });
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            target.textContent = '';
            target.blur();
        }
        if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const flat = flatVisible(State.getZoomRoot());
            if (flat.length > 0) {
                focusNode(flat[flat.length - 1].node.id);
            } else if (State.zoomStack.length > 0) {
                document.getElementById('zoom-title').focus();
            }
        }
        if (e.key === 'Backspace' && target.textContent === '') {
            e.preventDefault();
            const flat = flatVisible(State.getZoomRoot());
            if (flat.length > 0) {
                focusNode(flat[flat.length - 1].node.id);
            } else if (State.zoomStack.length > 0) {
                document.getElementById('zoom-title').focus();
            }
        }
        return;
    }

    if (target.matches('.bullet-desc')) {
        if (e.shiftKey && e.key === 'Enter') {
            e.preventDefault();
            target.blur();
            const row = target.closest('.bullet-row');
            if (row) {
                const textEl = row.querySelector('.bullet-text');
                if (textEl) textEl.focus();
            }
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            target.blur();
            const row = target.closest('.bullet-row');
            if (row) {
                const textEl = row.querySelector('.bullet-text');
                if (textEl) textEl.focus();
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            openSearch();
        }
    }
});

bulletsEl.addEventListener('click', (e) => {
    const target = e.target;

    if (target === bulletsEl) {
        const flat = flatVisible(State.getZoomRoot());
        if (flat.length > 0) focusNode(flat[flat.length - 1].node.id);
        return;
    }

    if (target.matches('.collapse-toggle.active')) {
        e.stopPropagation();
        const row = target.closest('.bullet-row');
        if (!row) return;
        const id = row.dataset.id;
        const node = findNode(id, State.doc.root);
        if (!node) return;
        node.collapsed = !node.collapsed;
        State.saveDoc();
        render();
        return;
    }

    if (target.matches('.bullet-dot')) {
        e.stopPropagation();
        const row = target.closest('.bullet-row');
        if (!row) return;
        const id = row.dataset.id;
        if (id) zoomInto(id);
        return;
    }

    if (target.matches('.bullet-desc-view')) {
        const row = target.closest('.bullet-row');
        if (!row) return;
        showDescEditor(row);
        const descEl = row.querySelector('.bullet-desc');
        if (descEl) descEl.focus();
        return;
    }

    if (target.id === 'ghost-row' || (target !== bulletsEl && target.closest('#ghost-row'))) {
        const ghostText = document.getElementById('ghost-text');
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
        const id = row.dataset.id;
        const dx = e.changedTouches[0].clientX - (row.dataset.touchStartX || 0);
        const dy = e.changedTouches[0].clientY - (row.dataset.touchStartY || 0);
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 2) {
            if (dx > 0) indentNode(id);
            else unindentNode(id);
        }
    }
}, { passive: true });

// ── Zoom title / desc ─────────────────────────────────────────────────────────

const zoomTitleEl = document.getElementById('zoom-title');
const zoomDescEl = document.getElementById('zoom-desc');

zoomTitleEl.addEventListener('blur', () => {
    const zoomRoot = State.getZoomRoot();
    if (zoomRoot && State.zoomStack.length > 0) {
        const newText = zoomTitleEl.textContent;
        if (newText !== zoomRoot.text) {
            zoomRoot.text = newText;
            State.saveDoc();
            renderBreadcrumb();
        }
    }
});

zoomDescEl.addEventListener('blur', () => {
    const zoomRoot = State.getZoomRoot();
    if (zoomRoot && State.zoomStack.length > 0) {
        const newDesc = zoomDescEl.textContent;
        if (newDesc !== (zoomRoot.description || '')) {
            zoomRoot.description = newDesc;
            State.saveDoc();
        }
    }
});

zoomTitleEl.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        zoomDescEl.focus();
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        zoomTitleEl.blur();
        const zoomRoot = State.getZoomRoot();
        if (zoomRoot) {
            if (zoomRoot.children.length === 0) {
                requestAnimationFrame(() => {
                    const ghostText = document.getElementById('ghost-text');
                    if (ghostText) ghostText.focus();
                });
            } else {
                State.pushUndo();
                const newNode = makeNode('');
                zoomRoot.children.unshift(newNode);
                State.saveDoc();
                render();
                requestAnimationFrame(() => focusNode(newNode.id, false));
            }
        }
        return;
    }
    if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const flat = flatVisible(State.getZoomRoot());
        if (flat.length > 0) focusNodeAtStart(flat[0].node.id);
        return;
    }
    if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const flat = flatVisible(State.getZoomRoot());
        if (flat.length > 0) focusNode(flat[flat.length - 1].node.id);
        return;
    }
    if ((e.altKey && e.key === 'ArrowLeft') || e.key === 'Escape') {
        e.preventDefault();
        zoomOut();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
    }
});

zoomDescEl.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        zoomDescEl.blur();
        zoomTitleEl.focus();
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        zoomDescEl.blur();
        zoomTitleEl.focus();
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
    }
});

// ── Global key handler ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isEditing = active && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

    if (e.key === 'Escape') {
        if (!document.getElementById('modal-login').classList.contains('hidden')) {
            closeModal('modal-login'); return;
        }
        if (!document.getElementById('modal-conflict').classList.contains('hidden')) {
            closeModal('modal-conflict'); return;
        }
        if (!document.getElementById('modal-markdown').classList.contains('hidden')) {
            closeModal('modal-markdown'); return;
        }
        if (!document.getElementById('modal-shortcuts').classList.contains('hidden')) {
            closeModal('modal-shortcuts'); return;
        }
        if (!document.getElementById('modal-options').classList.contains('hidden')) {
            closeModal('modal-options'); return;
        }
        if (document.getElementById('search-bar').classList.contains('visible')) {
            endSearch();
            return;
        }
    }

    if (!isEditing) {
        if (e.key === 'Enter' && !e.defaultPrevented && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            const ghostText = document.getElementById('ghost-text');
            if (ghostText) ghostText.focus();
            return;
        }
        if (e.key === '?') { e.preventDefault(); openModal('modal-shortcuts'); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openSearch(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
        if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const flat = flatVisible(State.getZoomRoot());
            if (flat.length > 0) { e.preventDefault(); focusNodeAtStart(flat[0].node.id); }
            return;
        }
        if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const flat = flatVisible(State.getZoomRoot());
            if (flat.length > 0) { e.preventDefault(); focusNode(flat[flat.length - 1].node.id); }
            return;
        }
    }
});

// ── URL / history ─────────────────────────────────────────────────────────────

window.addEventListener('popstate', () => {
    State.loadFromHash();
    render();
});

// ── Visibility ────────────────────────────────────────────────────────────────

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && State.syncIntervalId) syncNow();
});

// ── Toolbar ───────────────────────────────────────────────────────────────────

document.getElementById('btn-markdown').addEventListener('click', () => {
    document.getElementById('markdown-text').value = exportMarkdown(State.doc.root).trim();
    openModal('modal-markdown');
    setTimeout(() => document.getElementById('markdown-text').focus(), 50);
});

document.getElementById('btn-apply-markdown').addEventListener('click', () => {
    const text = document.getElementById('markdown-text').value;
    applyMarkdownImport(text);
    closeModal('modal-markdown');
});

document.getElementById('btn-options').addEventListener('click', () => {
    openModal('modal-options');
});

document.getElementById('btn-toggle-theme').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(State.THEME_KEY, next);
    applyTheme(next);
});

document.getElementById('btn-toggle-sync').addEventListener('click', async () => {
    State.setSyncEnabled(!State.syncEnabled);
    localStorage.setItem(State.SYNC_ENABLED_KEY, String(State.syncEnabled));
    renderSyncToggle();
    if (State.syncEnabled) {
        const session = await getActiveSession();
        if (session) startSync();
    } else {
        stopSync();
    }
});

document.getElementById('btn-toggle-dev').addEventListener('click', () => {
    State.setDevMode(!State.devMode);
    localStorage.setItem(State.DEV_MODE_KEY, String(State.devMode));
    applyDevMode();
});

// ── Modal close buttons ───────────────────────────────────────────────────────

document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
    el.addEventListener('click', () => {
        const modal = el.dataset.modal || el.closest('.modal-overlay')?.id;
        if (modal) closeModal(modal);
    });
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay.id);
    });
});

// ── Search ────────────────────────────────────────────────────────────────────

document.getElementById('search-input').addEventListener('input', (e) => {
    doSearch(e.target.value);
});
document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextMatch(); }
    if (e.key === 'Escape') { endSearch(); }
});
document.getElementById('search-close').addEventListener('click', endSearch);

// ── Toolbar hint ──────────────────────────────────────────────────────────────

document.querySelector('.toolbar-hint').addEventListener('click', () => openModal('modal-shortcuts'));

// ── Login modal ───────────────────────────────────────────────────────────────

document.getElementById('btn-login-switch').addEventListener('click', () => {
    setLoginMode(loginMode === 'signin' ? 'signup' : 'signin');
});

document.getElementById('btn-login-submit').addEventListener('click', () => {
    handleLoginSubmit(loginMode);
});

// ── Conflict modal ────────────────────────────────────────────────────────────

document.getElementById('btn-conflict-use-local').addEventListener('click', handleConflictUseLocal);
document.getElementById('btn-conflict-use-remote').addEventListener('click', handleConflictUseRemote);
document.getElementById('btn-conflict-apply').addEventListener('click', () => {
    const text = document.getElementById('conflict-resolved').value;
    handleConflictApply(text);
});

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
    applyTheme(localStorage.getItem(State.THEME_KEY) || 'light');
    const loaded = State.loadDoc();
    if (!loaded) {
        const splash = document.getElementById('splash');
        if (splash) splash.classList.remove('hidden');
        seedDoc(State.doc);
        State.saveDocLocal();
    }
    State.loadFromHash();
    render();
    initAuth();
    renderSyncToggle();
    applyDevMode();

    const splash = document.getElementById('splash');
    if (splash && !splash.classList.contains('hidden')) {
        setTimeout(() => {
            splash.classList.add('fade-out');
            setTimeout(() => splash.classList.add('hidden'), 700);
        }, 800);
    }
}

init();
