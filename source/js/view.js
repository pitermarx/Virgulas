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

// SVG icons for each sync state (14×14 viewBox)
function syncSvg(status) {
    if (status === 'online') {
        // Cloud icon: always-on indicator that sync is active
        return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10a2.5 2.5 0 0 1 0-5h.3A4 4 0 1 1 11 8"/><path d="M9 10l1.5 1.5 3-3" stroke-width="1.6"/></svg>`;
    }
    if (status === 'pending') {
        // Cloud with upload arrow
        return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10.5a2.5 2.5 0 0 1 0-5h.3A4 4 0 1 1 11.5 9"/><line x1="7" y1="13" x2="7" y2="8"/><polyline points="5,10 7,8 9,10"/></svg>`;
    }
    if (status === 'synced') {
        // Checkmark
        return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2,7 5.5,11 12,3.5"/></svg>`;
    }
    if (status === 'error') {
        // Warning triangle
        return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 1L13 13H1L7 1Z"/><line x1="7" y1="5.5" x2="7" y2="8.5"/><circle cx="7" cy="11" r="0.5" fill="currentColor"/></svg>`;
    }
    if (status === 'conflict') {
        // Lightning bolt
        return `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="8.5,1 5,7.5 8,7.5 5.5,13"/></svg>`;
    }
    return '';
}

export function setSyncStatus(status) {
    State.setSyncStatusVar(status);
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = '';
    el.innerHTML = '';
    el.onclick = null;
    el.title = '';
    if (status === 'idle') return;
    el.classList.add('visible', status);
    if (status === 'syncing') {
        el.innerHTML = '<span class="sync-spinner" aria-hidden="true"></span>';
        el.title = 'Syncing…';
    } else if (status === 'synced') {
        el.innerHTML = syncSvg('synced');
        el.title = 'Synced';
        setTimeout(() => { if (State.syncStatus === 'synced') setSyncStatus('online'); }, 3000);
    } else if (status === 'pending') {
        el.innerHTML = syncSvg('pending');
        el.title = 'Pending sync';
    } else if (status === 'error') {
        el.innerHTML = syncSvg('error');
        el.title = 'Sync error';
    } else if (status === 'conflict') {
        el.innerHTML = syncSvg('conflict');
        el.title = 'Conflict – click to resolve';
        el.onclick = () => openModal('modal-conflict');
    } else if (status === 'online') {
        el.innerHTML = syncSvg('online');
        el.title = 'Online sync active';
    }
    if (State.devMode) renderDevPanel();
}

// ── Storage indicator ─────────────────────────────────────────────────────────

const STORAGE_LIMIT_BYTES = 20 * 1024; // 20 KB non-enforced limit

export async function updateStorageIndicator() {
    const el = document.getElementById('storage-indicator');
    if (!el) return;
    let bytes;
    try {
        const encrypted = await State.encryptPayload(State.doc);
        bytes = new TextEncoder().encode(encrypted).length;
    } catch (e) {
        console.error('updateStorageIndicator: failed to compute encrypted size', e);
        const raw = localStorage.getItem(State.STORAGE_KEY) || '';
        bytes = new TextEncoder().encode(raw).length;
    }
    const ratio = Math.min(bytes / STORAGE_LIMIT_BYTES, 1);
    const pct = Math.round(ratio * 100);
    const kbUsed = (bytes / 1024).toFixed(1);
    const kbLimit = (STORAGE_LIMIT_BYTES / 1024).toFixed(0);

    // Color: green < 60%, orange 60–85%, red > 85%
    let color;
    if (ratio < 0.6) color = '#4caf50';
    else if (ratio < 0.85) color = '#ff9800';
    else color = '#c0392b';

    // Track color matches --border light theme; acceptable in both themes
    const trackColor = '#ddd9d0';

    // Mini pie chart using SVG circle stroke-dasharray trick
    // Circle r=5, circumference ≈ 31.42
    const r = 5;
    const circ = 2 * Math.PI * r;
    const filled = circ * ratio;
    const empty = circ - filled;

    el.classList.add('visible');
    el.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="${r}" fill="none" stroke="${trackColor}" stroke-width="2.5"/>
      <circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2.5"
        stroke-dasharray="${filled.toFixed(2)} ${empty.toFixed(2)}"
        transform="rotate(-90 7 7)"/>
    </svg>`;
    el.title = `Data: ${kbUsed} KB / ${kbLimit} KB${ratio >= 1 ? ' – over limit!' : ` (${pct}%)`}`;
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
        crumb.className = i === State.zoomStack.length - 1 ? 'crumb crumb-last' : 'crumb';
        crumb.textContent = node ? (node.text || 'Untitled') : 'Untitled';
        if (i < State.zoomStack.length - 1) {
            crumb.addEventListener('click', () => _onZoomTo(State.zoomStack.slice(0, i + 1)));
        }
        el.appendChild(crumb);
    });
}

export function renderZoomHeader(zoomRoot) {
    const descEl = document.getElementById('zoom-desc');
    if (State.zoomStack.length === 0) {
        descEl.classList.remove('visible');
        return;
    }
    descEl.classList.add('visible');

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
