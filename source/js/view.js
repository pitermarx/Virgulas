// ── View ──────────────────────────────────────────────────────────────────────
// Pure DOM rendering. Reads state; does NOT add event listeners.

import { renderInline, flatVisible, findNode, countNodes, escapeHtml } from './model.js';
import { encryptPayload } from './sync.js';
import State from './state.js';

// ── DOM helpers (shared by app.js / sync.js) ──────────────────────────────────

export const byId = (id) => document.getElementById(id);
export const setHidden = (id, hidden) => byId(id)?.classList.toggle('hidden', hidden);
const setVisible = (id, visible) => byId(id)?.classList.toggle('visible', visible);
export const setText = (id, text) => { const el = byId(id); if (el) el.textContent = text; };
export const esc = escapeHtml;

const cloneTemplate = (id) => byId(id)?.content.firstElementChild.cloneNode(true);
const within = (root, selector) => root.querySelector(selector);
const depthSize = (depth) => depth === 0 ? '100%' : depth === 1 ? '95%' : '90%';

function h(tag, cls, props) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (props) Object.assign(el, props);
    return el;
}

// ── Theme ─────────────────────────────────────────────────────────────────────

export function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = byId('btn-toggle-theme');
    if (btn) btn.textContent = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

// ── Login mode ────────────────────────────────────────────────────────────────

export function renderLoginMode() {
    const isSignIn = State.loginMode === 'signin';
    setText('login-modal-title', isSignIn ? 'Sign in' : 'Sign up');
    setText('btn-login-submit', isSignIn ? 'Sign in' : 'Sign up');
    setHidden('login-confirm-password', isSignIn);
    setText('login-switch-text', isSignIn ? "Don't have an account?" : 'Already have an account?');
    setText('btn-login-switch', isSignIn ? 'Sign up' : 'Sign in');
    setHidden('login-error', true);
    setHidden('login-success', true);
}

// ── Search UI ─────────────────────────────────────────────────────────────────

function renderSearchUI() {
    setVisible('search-bar', State.searchOpen);
    byId('app')?.classList.toggle('search-open', State.searchOpen);

    const input = byId('search-input');
    if (input && input.value !== State.searchQuery) input.value = State.searchQuery;

    const total = State.searchMatches.length;
    setText('search-count', State.searchQuery
        ? (total === 0 ? 'No matches' : `${State.searchIdx + 1} / ${total}`)
        : '');
}

function renderModals() {
    document.querySelectorAll('.modal-overlay').forEach((modal) => {
        modal.classList.toggle('hidden', modal.id !== State.activeModal);
    });
}

function renderLoginFeedback() {
    setText('login-error', State.loginError);
    setText('login-success', State.loginSuccess);
    setHidden('login-error', !State.loginError);
    setHidden('login-success', !State.loginSuccess);
}

function renderDraftFields() {
    const markdown = byId('markdown-text');
    if (markdown && markdown.value !== State.markdownDraft) markdown.value = State.markdownDraft;

    const localEl = byId('conflict-local');
    if (localEl && localEl.value !== (State.conflictLocal || '')) localEl.value = State.conflictLocal || '';

    const remoteEl = byId('conflict-remote');
    if (remoteEl && remoteEl.value !== (State.conflictRemote || '')) remoteEl.value = State.conflictRemote || '';

    const resolvedEl = byId('conflict-resolved');
    if (resolvedEl && resolvedEl.value !== (State.conflictResolved || '')) resolvedEl.value = State.conflictResolved || '';
}

export function renderChrome() {
    renderModals();
    renderSearchUI();
    renderLoginFeedback();
    renderDraftFields();
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export function showToast(message) {
    const el = byId('toast');
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

const SYNC_TITLES = {
    syncing: 'Syncing…', synced: 'Synced', pending: 'Pending sync',
    error: 'Sync error', conflict: 'Conflict – click to resolve', online: 'Online sync active',
};

export function renderSyncStatus() {
    const status = State.syncStatus;
    const el = byId('sync-indicator');
    if (!el) return;
    el.className = '';
    el.title = '';
    el.querySelectorAll('[id^="sync-svg-"]').forEach(s => s.classList.remove('active'));
    if (status === 'idle') return;
    el.classList.add('visible', status);
    el.title = SYNC_TITLES[status] || '';
    const icon = byId(status === 'syncing' ? 'sync-svg-syncing' : 'sync-svg-' + status);
    if (icon) icon.classList.add('active');
    if (State.devMode) renderDevPanel();
}

// ── Storage indicator ─────────────────────────────────────────────────────────

const STORAGE_LIMIT_BYTES = 20 * 1024;

export async function updateStorageIndicator() {
    const el = byId('storage-indicator');
    const fill = byId('storage-fill');
    if (!el) return;
    if (!State.encryptionKey) {
        el.classList.remove('visible');
        return;
    }
    let bytes = new TextEncoder().encode(await encryptPayload(State.encryptionKey, State.doc)).length;
    const ratio = Math.min(bytes / STORAGE_LIMIT_BYTES, 1);
    const pct = Math.round(ratio * 100);
    const kbUsed = (bytes / 1024).toFixed(1);
    const kbLimit = (STORAGE_LIMIT_BYTES / 1024).toFixed(0);
    const color = ratio < 0.6 ? '#4caf50' : ratio < 0.85 ? '#ff9800' : '#c0392b';
    const r = 5, circ = 2 * Math.PI * r, filled = circ * ratio;

    el.classList.add('visible');
    el.title = `Data: ${kbUsed} KB / ${kbLimit} KB${ratio >= 1 ? ' – over limit!' : ` (${pct}%)`}`;
    if (fill) {
        fill.setAttribute('stroke', color);
        fill.setAttribute('stroke-dasharray', `${filled.toFixed(2)} ${(circ - filled).toFixed(2)}`);
    }
}

// ── Dev panel ─────────────────────────────────────────────────────────────────

export function renderDevPanel() {
    const content = byId('dev-panel-content');
    if (!content) return;
    const rows = [
        ['syncStatus', State.syncStatus],
        ['pendingSync', State.pendingSync],
        ['lastSyncedVersion', State.lastSyncedVersion],
        ['zoomStack', JSON.stringify(State.zoomStack)],
        ['focusedId', State.focusedId || '—'],
        ['selectedIds', JSON.stringify(State.selectedIds)],
        ['undoStack.length', State.undoStack.length],
        ['doc.version', State.doc.version || 1],
        ['total nodes', countNodes(State.doc.root)],
    ];
    content.innerHTML =
        rows.map(([k, v]) => `<div class="dev-row"><span class="dev-key">${esc(k)}</span><span class="dev-val">${esc(v)}</span></div>`).join('') +
        `<details><summary>doc JSON</summary><pre>${esc(JSON.stringify(State.doc, null, 2))}</pre></details>`;
}

export function applyDevMode() {
    const panel = byId('dev-panel');
    const btn = byId('btn-toggle-dev');
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

export function renderAuthUI() {
    const authUI = byId('auth-ui');
    if (!authUI) return;
    const user = State.currentUser;
    const content = cloneTemplate(user ? 'template-auth-user' : 'template-auth-guest');
    if (!content) return;
    if (user) within(content, '[data-auth-email]').textContent = user.email;
    authUI.replaceChildren(content);
}

// ── Description helpers ───────────────────────────────────────────────────────

export function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function showDescEditor(row) {
    within(row, '.bullet-desc-view').classList.remove('visible');
    const descEl = within(row, '.bullet-desc');
    descEl.classList.add('editing');
    autoResize(descEl);
    descEl.setSelectionRange(descEl.value.length, descEl.value.length);
}

export function renderDescView(row, node) {
    const descView = within(row, '.bullet-desc-view');
    descView.innerHTML = renderInline(node.description || '');
    descView.classList.toggle('visible', !!node.description);
}

// ── Cursor ────────────────────────────────────────────────────────────────────

export function setCursor(el, toEnd) {
    const sel = window.getSelection();
    const range = document.createRange();
    if (toEnd) { range.selectNodeContents(el); range.collapse(false); }
    else { range.setStart(el, 0); range.collapse(true); }
    sel.removeAllRanges();
    sel.addRange(range);
}

export function applySelectionHighlights() {
    document.querySelectorAll('.bullet-row.selected').forEach(el => el.classList.remove('selected'));
    State.selectedIds.forEach(id => {
        document.querySelector(`.bullet-row[data-id="${id}"]`)?.classList.add('selected');
    });
}

// ── Bullet rows ───────────────────────────────────────────────────────────────

export function buildRow(node, depth) {
    const row = cloneTemplate('template-bullet-row');
    if (!row) return h('div');
    const hasKids = node.children.length > 0;

    row.classList.toggle('has-children', hasKids);
    row.classList.toggle('collapsed', node.collapsed);
    row.dataset.id = node.id;
    row.style.marginLeft = (depth * 20) + 'px';

    const toggle = within(row, '.collapse-toggle');
    const textEl = within(row, '.bullet-text');
    const descEl = within(row, '.bullet-desc');
    const content = within(row, '.bullet-content');

    toggle.classList.toggle('active', hasKids);
    toggle.textContent = node.collapsed ? '▶' : '▼';
    toggle.title = node.collapsed ? 'Expand' : 'Collapse';
    textEl.dataset.id = node.id;
    textEl.dataset.placeholder = 'New item…';
    textEl.innerHTML = renderInline(node.text);

    content.style.fontSize = depthSize(depth);
    descEl.value = node.description || '';
    renderDescView(row, node);
    return row;
}

export function buildGhostRow() {
    const row = cloneTemplate('template-ghost-row');
    if (!row) return h('div');
    within(row, '.bullet-text').dataset.placeholder = 'New item…';
    return row;
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

export function renderBreadcrumb() {
    const el = byId('breadcrumb');
    if (!el) return;
    if (State.zoomStack.length === 0) {
        el.classList.remove('visible');
        el.replaceChildren();
        return;
    }
    el.classList.add('visible');
    el.replaceChildren();

    const addCrumb = (text, cls, depth) => {
        const crumb = cloneTemplate('template-crumb') || h('span', cls);
        crumb.className = cls;
        crumb.textContent = text;
        if (depth !== null) crumb.dataset.zoomDepth = String(depth);
        el.appendChild(crumb);
    };

    const addSeparator = () => {
        const sep = cloneTemplate('template-crumb-sep') || h('span', 'crumb-sep', { textContent: ' / ' });
        el.appendChild(sep);
    };

    addCrumb('Home', 'crumb', 0);

    State.zoomStack.forEach((id, i) => {
        addSeparator();
        const node = findNode(id, State.doc.root);
        const isLast = i === State.zoomStack.length - 1;
        addCrumb(node ? (node.text || 'Untitled') : 'Untitled', isLast ? 'crumb crumb-last' : 'crumb', isLast ? null : i + 1);
    });
}

export function renderZoomHeader(zoomRoot) {
    const descEl = byId('zoom-desc');
    if (State.zoomStack.length === 0) { descEl.classList.remove('visible'); return; }
    descEl.classList.add('visible');
    if (document.activeElement !== descEl) descEl.textContent = zoomRoot.description || '';
}

// ── Main render ───────────────────────────────────────────────────────────────

export function render() {
    const bulletsEl = byId('bullets');
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);

    bulletsEl.innerHTML = '';
    for (const { node, depth } of flat) bulletsEl.appendChild(buildRow(node, depth));

    State.searchMatches.forEach((id, i) => {
        const el = bulletsEl.querySelector(`.bullet-row[data-id="${id}"]`);
        if (!el) return;
        el.classList.add('search-match');
        if (i === State.searchIdx) el.classList.add('search-current');
    });

    bulletsEl.appendChild(buildGhostRow());
    applySelectionHighlights();
    renderBreadcrumb();
    renderZoomHeader(zoomRoot);
    requestAnimationFrame(() => bulletsEl.querySelectorAll('.bullet-desc').forEach(autoResize));
    if (State.devMode) renderDevPanel();
}
