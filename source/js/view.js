// ── View ──────────────────────────────────────────────────────────────────────
// Pure DOM rendering functions. Reads state; does NOT add event listeners
// on individual rows (all events are handled via delegation in app.js).
// This is the "View" layer in the Elm-inspired architecture.

import { renderInline, flatVisible, findNode, countNodes } from './model.js';
import * as State from './state.js';

// ── Theme ─────────────────────────────────────────────────────────────────────

export function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('btn-toggle-theme');
    if (btn) btn.textContent = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

export function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

export function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

// ── Login mode ────────────────────────────────────────────────────────────────

export let loginMode = 'signin';

export function setLoginMode(mode) {
    loginMode = mode;
    const isSignIn = mode === 'signin';
    document.getElementById('login-modal-title').textContent = isSignIn ? 'Sign in' : 'Sign up';
    document.getElementById('btn-login-submit').textContent = isSignIn ? 'Sign in' : 'Sign up';
    document.getElementById('login-confirm-password').classList.toggle('hidden', isSignIn);
    document.getElementById('login-switch-text').textContent = isSignIn ? "Don't have an account?" : 'Already have an account?';
    document.getElementById('btn-login-switch').textContent = isSignIn ? 'Sign up' : 'Sign in';
    document.getElementById('login-error').classList.add('hidden');
    document.getElementById('login-success').classList.add('hidden');
}

// ── Search UI ─────────────────────────────────────────────────────────────────

export function openSearch() {
    document.getElementById('search-bar').classList.add('visible');
    document.getElementById('app').classList.add('search-open');
    document.getElementById('search-input').focus();
}

export function closeSearch() {
    document.getElementById('search-bar').classList.remove('visible');
    document.getElementById('app').classList.remove('search-open');
    document.getElementById('search-input').value = '';
    document.getElementById('search-count').textContent = '';
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export function showToast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    el.classList.add('visible');
    clearTimeout(el._toastTimeout);
    el._toastTimeout = setTimeout(() => {
        el.classList.remove('visible');
        setTimeout(() => el.classList.add('hidden'), 200);
    }, 2000);
}

// ── Sync indicator ────────────────────────────────────────────────────────────

export function setSyncStatus(status) {
    State.setSyncStatusVar(status);
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = '';
    el.innerHTML = '';
    el.onclick = null;
    if (status === 'idle') return;
    el.classList.add('visible', status);
    if (status === 'syncing') {
        el.innerHTML = '<span class="sync-spinner"></span><span>Syncing…</span>';
    } else if (status === 'synced') {
        el.innerHTML = '<span class="sync-dot"></span><span>Synced</span>';
        setTimeout(() => { if (State.syncStatus === 'synced') setSyncStatus('idle'); }, 3000);
    } else if (status === 'pending') {
        el.innerHTML = '<span class="sync-dot"></span><span>Pending</span>';
    } else if (status === 'error') {
        el.innerHTML = '<span class="sync-dot"></span><span>Sync error</span>';
    } else if (status === 'conflict') {
        el.innerHTML = '<span class="sync-dot"></span><span>Conflict – click to resolve</span>';
        el.onclick = () => openModal('modal-conflict');
    }
    if (State.devMode) renderDevPanel();
}


// ── Dev panel ─────────────────────────────────────────────────────────────────

export function renderDevPanel() {
    const content = document.getElementById('dev-panel-content');
    if (!content) return;
    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    const rows = [
        ['syncStatus', State.syncStatus],
        ['pendingSync', String(State.pendingSync)],
        ['lastSyncedVersion', String(State.lastSyncedVersion)],
        ['zoomStack', JSON.stringify(State.zoomStack)],
        ['focusedId', State.focusedId || '—'],
        ['selectedIds', JSON.stringify(State.selectedIds)],
        ['undoStack.length', String(State.undoStack.length)],
        ['doc.version', String(State.doc.version || 1)],
        ['total nodes', String(countNodes(State.doc.root))],
    ];
    content.innerHTML =
        rows.map(([k, v]) =>
            `<div class="dev-row"><span class="dev-key">${esc(k)}</span><span class="dev-val">${esc(v)}</span></div>`
        ).join('') +
        `<details><summary>doc JSON</summary><pre>${esc(JSON.stringify(State.doc, null, 2))}</pre></details>`;
}

export function applyDevMode() {
    const panel = document.getElementById('dev-panel');
    const btn = document.getElementById('btn-toggle-dev');
    if (!panel) return;
    if (State.devMode) {
        panel.classList.remove('hidden');
        if (btn) btn.textContent = 'Disable dev mode';
        renderDevPanel();
    } else {
        panel.classList.add('hidden');
        if (btn) btn.textContent = 'Enable dev mode';
    }
}

// ── Description helpers ───────────────────────────────────────────────────────

export function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function showDescEditor(row) {
    const descView = row.querySelector('.bullet-desc-view');
    const descEl = row.querySelector('.bullet-desc');
    descView.classList.remove('visible');
    descEl.classList.add('editing');
    autoResize(descEl);
    const end = descEl.value.length;
    descEl.setSelectionRange(end, end);
}

// ── Bullet rows ───────────────────────────────────────────────────────────────

export function buildRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'bullet-row';
    if (node.children.length > 0) row.classList.add('has-children');
    if (node.collapsed) row.classList.add('collapsed');
    row.dataset.id = node.id;
    row.style.marginLeft = (depth * 20) + 'px';

    const gutter = document.createElement('div');
    gutter.className = 'bullet-gutter';

    const toggle = document.createElement('div');
    toggle.className = 'collapse-toggle' + (node.children.length > 0 ? ' active' : '');
    toggle.textContent = node.collapsed ? '▶' : '▼';
    toggle.title = node.collapsed ? 'Expand' : 'Collapse';

    const dot = document.createElement('div');
    dot.className = 'bullet-dot';
    dot.title = 'Zoom in';

    gutter.append(toggle, dot);

    const content = document.createElement('div');
    content.className = 'bullet-content';
    const fsize = depth === 0 ? '100%' : depth === 1 ? '95%' : '90%';
    content.style.fontSize = fsize;

    const textEl = document.createElement('div');
    textEl.className = 'bullet-text';
    textEl.contentEditable = 'true';
    textEl.spellcheck = true;
    textEl.dataset.id = node.id;
    textEl.dataset.placeholder = 'New item…';
    textEl.innerHTML = renderInline(node.text);

    const descView = document.createElement('div');
    descView.className = 'bullet-desc-view' + (node.description ? ' visible' : '');
    descView.textContent = node.description || '';

    const descEl = document.createElement('textarea');
    descEl.className = 'bullet-desc';
    descEl.value = node.description || '';
    descEl.rows = 1;
    descEl.placeholder = 'Description…';

    content.append(textEl, descView, descEl);
    row.append(gutter, content);
    return row;
}

export function buildGhostRow() {
    const row = document.createElement('div');
    row.className = 'ghost-row';
    row.id = 'ghost-row';

    const gutter = document.createElement('div');
    gutter.className = 'bullet-gutter';

    const toggle = document.createElement('div');
    toggle.className = 'collapse-toggle';

    const dot = document.createElement('div');
    dot.className = 'bullet-dot';

    gutter.append(toggle, dot);

    const content = document.createElement('div');
    content.className = 'bullet-content';

    const textEl = document.createElement('div');
    textEl.className = 'bullet-text';
    textEl.contentEditable = 'true';
    textEl.id = 'ghost-text';
    textEl.dataset.placeholder = 'New item…';

    content.append(textEl);
    row.append(gutter, content);
    return row;
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

// onZoomTo is injected by app.js to avoid a circular import
let _onZoomTo = () => { };
export function setZoomToCallback(fn) { _onZoomTo = fn; }

export function renderBreadcrumb() {
    const el = document.getElementById('breadcrumb');
    if (State.zoomStack.length === 0) {
        el.classList.remove('visible');
        return;
    }
    el.classList.add('visible');
    el.innerHTML = '';

    const rootCrumb = document.createElement('span');
    rootCrumb.className = 'crumb';
    rootCrumb.textContent = 'Home';
    rootCrumb.addEventListener('click', () => _onZoomTo([]));
    el.appendChild(rootCrumb);

    State.zoomStack.forEach((id, i) => {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = ' / ';
        el.appendChild(sep);

        const node = findNode(id, State.doc.root);
        const crumb = document.createElement('span');
        crumb.className = 'crumb';
        crumb.textContent = node ? (node.text || 'Untitled') : 'Untitled';
        if (i < State.zoomStack.length - 1) {
            crumb.addEventListener('click', () => _onZoomTo(State.zoomStack.slice(0, i + 1)));
        }
        el.appendChild(crumb);
    });
}

export function renderZoomHeader(zoomRoot) {
    const titleEl = document.getElementById('zoom-title');
    const descEl = document.getElementById('zoom-desc');
    if (State.zoomStack.length === 0) {
        titleEl.classList.remove('visible');
        descEl.classList.remove('visible');
        return;
    }
    titleEl.classList.add('visible');
    descEl.classList.add('visible');

    if (document.activeElement !== titleEl) {
        titleEl.textContent = zoomRoot.text || '';
    }
    if (document.activeElement !== descEl) {
        descEl.textContent = zoomRoot.description || '';
    }
}

// ── Main render ───────────────────────────────────────────────────────────────

export function render() {
    const bulletsEl = document.getElementById('bullets');
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);

    bulletsEl.innerHTML = '';

    for (const { node, depth } of flat) {
        bulletsEl.appendChild(buildRow(node, depth));
    }

    if (State.searchMatches.length > 0) {
        State.searchMatches.forEach((id, i) => {
            const el = bulletsEl.querySelector(`.bullet-row[data-id="${id}"]`);
            if (el) {
                el.classList.add('search-match');
                if (i === State.searchIdx) el.classList.add('search-current');
            }
        });
    }

    bulletsEl.appendChild(buildGhostRow());

    renderBreadcrumb();
    renderZoomHeader(zoomRoot);

    // Resize all description textareas after DOM is built
    requestAnimationFrame(() => {
        bulletsEl.querySelectorAll('.bullet-desc').forEach(autoResize);
    });

    if (State.devMode) renderDevPanel();
}
