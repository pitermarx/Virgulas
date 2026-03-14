// ── Update ────────────────────────────────────────────────────────────────────
// State-modifying operations.

import { makeNode, findNode, flatVisible, findParentInSubtree, collectAllNodes, importMarkdown, exportMarkdown } from './model.js';
import State from './state.js';
import { render, openSearch, closeSearch, openModal, showToast, showDescEditor, setCursor, byId } from './view.js';
import { isCmdKey, isPlainKey, isArrowKey, isArrowNoMods } from './keys.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function getNodeCtx(id, zoomRoot = State.getZoomRoot()) {
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent) return null;
    const idx = parent.children.findIndex(c => c.id === id);
    return idx === -1 ? null : { zoomRoot, parent, idx, node: parent.children[idx] };
}

function persistAndRender(afterRender) {
    State.saveDoc();
    render();
    if (afterRender) requestAnimationFrame(afterRender);
}

function mutateDoc(mutator, afterRender) {
    State.pushUndo();
    const result = mutator();
    persistAndRender(afterRender ? () => afterRender(result) : null);
    return result;
}

function moveChild(children, from, to) {
    children.splice(to, 0, children.splice(from, 1)[0]);
}

function getBulletTextEl(id) {
    return document.querySelector(`.bullet-text[data-id="${id}"]`);
}

function syncNodeTextFromDom(node) {
    const el = getBulletTextEl(node.id);
    if (el) node.text = el.textContent;
}

function updateSearchCountText() {
    const el = byId('search-count');
    const total = State.searchMatches.length;
    el.textContent = total === 0 ? 'No matches' : `${State.searchIdx + 1} / ${total}`;
}

function runOnTarget(nodeId, action) {
    const ids = State.selectedIds.length > 1 ? State.selectedIds : [nodeId];
    if (ids.length === 1) clearSelection();
    action(ids);
}

function orderedIds(ids, flat) {
    const idx = new Map(flat.map((x, i) => [x.node.id, i]));
    return [...ids]
        .map(id => ({ id, fi: idx.get(id) }))
        .filter(x => Number.isInteger(x.fi))
        .sort((a, b) => a.fi - b.fi);
}

function orderedSelection(ids, zoomRoot = State.getZoomRoot()) {
    const flat = flatVisible(zoomRoot);
    return { zoomRoot, flat, ordered: orderedIds(ids, flat) };
}

function focusSelectionHead() {
    applySelectionHighlights();
    State.keepSelection = true;
    focusNode(State.selectionHead);
    State.keepSelection = false;
}

// ── Cursor & focus ────────────────────────────────────────────────────────────

function focusWithCursor(id, cursor) {
    State.focusedId = id;
    const el = getBulletTextEl(id);
    if (!el) return;
    el.focus();
    if (cursor === 'end') setCursor(el, true);
    if (cursor === 'start') setCursor(el, false);
}

export function focusNode(id, toEnd = true) {
    focusWithCursor(id, toEnd ? 'end' : 'keep');
}

export function focusNodeAtStart(id) {
    focusWithCursor(id, 'start');
}

export function focusPrev(id) {
    const flat = flatVisible(State.getZoomRoot());
    const idx = flat.findIndex(x => x.node.id === id);
    if (idx <= 0) {
        if (State.zoomStack.length > 0) byId('zoom-desc')?.focus();
        return;
    }
    focusNode(flat[idx - 1].node.id);
}

export function focusNext(id) {
    const flat = flatVisible(State.getZoomRoot());
    const idx = flat.findIndex(x => x.node.id === id);
    if (idx === -1) return;
    if (idx >= flat.length - 1) {
        byId('ghost-text')?.focus();
        return;
    }
    focusNodeAtStart(flat[idx + 1].node.id);
}

// ── Selection ─────────────────────────────────────────────────────────────────

export function clearSelection() {
    State.selectedIds = [];
    State.selectionAnchor = null;
    State.selectionHead = null;
    document.querySelectorAll('.bullet-row.selected').forEach(el => el.classList.remove('selected'));
}

export function applySelectionHighlights() {
    document.querySelectorAll('.bullet-row.selected').forEach(el => el.classList.remove('selected'));
    State.selectedIds.forEach(id => {
        document.querySelector(`.bullet-row[data-id="${id}"]`)?.classList.add('selected');
    });
}

export function extendSelection(currentId, dir) {
    const flat = flatVisible(State.getZoomRoot());
    if (!State.selectionAnchor) {
        State.selectionAnchor = currentId;
        State.selectionHead = currentId;
    }
    const headIdx = flat.findIndex(x => x.node.id === State.selectionHead);
    if (headIdx === -1) return;
    const newIdx = headIdx + dir;
    if (newIdx < 0 || newIdx >= flat.length) return;
    State.selectionHead = flat[newIdx].node.id;
    const ai = flat.findIndex(x => x.node.id === State.selectionAnchor);
    const hi = flat.findIndex(x => x.node.id === State.selectionHead);
    State.selectedIds = flat.slice(Math.min(ai, hi), Math.max(ai, hi) + 1).map(x => x.node.id);
    applySelectionHighlights();
    State.keepSelection = true;
    focusNode(State.selectionHead);
    State.keepSelection = false;
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

export function zoomInto(id) {
    State.zoomStack.push(id);
    State.focusedId = null;
    State.updateHash();
    render();
    requestAnimationFrame(() => {
        if (!('ontouchstart' in window)) byId('zoom-desc')?.focus();
    });
}

export function zoomOut() {
    if (State.zoomStack.length === 0) return;
    const prevId = State.zoomStack.pop();
    State.focusedId = prevId;
    State.updateHash();
    render();
    requestAnimationFrame(() => focusNode(prevId));
}

export function zoomTo(stack) {
    State.zoomStack = stack;
    State.focusedId = null;
    State.updateHash();
    render();
}

// ── Undo ──────────────────────────────────────────────────────────────────────

export function undo() {
    if (State.undoStack.length === 0) return;
    State.replaceDoc(JSON.parse(State.undoStack.pop()));
    State.saveDoc();
    render();
}

// ── Node operations ───────────────────────────────────────────────────────────

export function newBulletAfter(id) {
    const ctx = getNodeCtx(id);
    if (!ctx) return;
    const { parent, idx, node } = ctx;
    mutateDoc(() => {
        const created = makeNode('');
        if (!node.collapsed && node.children.length > 0) node.children.unshift(created);
        else parent.children.splice(idx + 1, 0, created);
        return created;
    }, (newNode) => focusNode(newNode.id, false));
}

export function appendGhostBullet(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    mutateDoc(() => State.getZoomRoot().children.push(makeNode(trimmed)));
    return true;
}

function deleteIds(ids) {
    const { zoomRoot, flat, ordered } = orderedSelection(ids);
    if (ordered.length === 0) return;
    const nodes = ordered.map(x => findNode(x.id, zoomRoot)).filter(Boolean);
    const withChildren = nodes.filter(node => node.children.length > 0);
    const label = ids.length === 1
        ? nodes[0]?.text ? `"${nodes[0].text}"` : 'this bullet'
        : `${ordered.length} bullet(s)`;
    if (withChildren.length > 0 && !window.confirm(`Delete ${label}${ids.length === 1 ? ` and its ${withChildren[0].children.length} child item(s)?` : ' and their children?'}`)) return;
    let focusTarget = null;
    for (let i = ordered[0].fi - 1; i >= 0; i--) {
        if (!ids.includes(flat[i].node.id)) { focusTarget = flat[i].node.id; break; }
    }
    mutateDoc(() => {
        for (const { id } of [...ordered].reverse()) {
            const parent = findParentInSubtree(id, zoomRoot);
            if (!parent) continue;
            const idx = parent.children.findIndex(c => c.id === id);
            if (idx !== -1) parent.children.splice(idx, 1);
        }
    }, () => focusTarget && focusNode(focusTarget));
    if (ids.length > 1) clearSelection();
    State.focusedId = focusTarget;
}

export function deleteNode(id) { deleteIds([id]); }
export function deleteNodes(ids) { deleteIds(ids); }

export function copySelectionAsMarkdown(ids) {
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);
    const nodes = orderedIds(ids, flat).map(x => findNode(x.id, zoomRoot)).filter(Boolean);
    const topLevel = nodes.filter(n => !nodes.some(o => o !== n && findNode(n.id, o)));
    navigator.clipboard.writeText(exportMarkdown({ children: topLevel }).trim())
        .then(() => showToast('Markdown copied'))
        .catch(() => showToast('Copy failed'));
}

function indentIds(ids, noFocus = false) {
    const { zoomRoot, ordered } = orderedSelection(ids);
    mutateDoc(() => {
        for (const { id } of ordered) {
            const ctx = getNodeCtx(id, zoomRoot);
            if (!ctx || ctx.idx === 0) continue;
            const { parent, idx, node } = ctx;
            parent.children.splice(idx, 1);
            const prev = parent.children[idx - 1];
            prev.collapsed = false;
            prev.children.push(node);
        }
    }, ids.length > 1 ? applySelectionHighlights : noFocus ? null : () => focusNode(ids[0]));
}

function unindentIds(ids, noFocus = false) {
    const { zoomRoot, ordered } = orderedSelection(ids);
    const insertCount = new Map();
    mutateDoc(() => {
        for (const { id } of ordered) {
            const ctx = getNodeCtx(id, zoomRoot);
            if (!ctx || ctx.parent === zoomRoot) continue;
            const { parent, idx: nodeIdx } = ctx;
            const grandParent = findParentInSubtree(parent.id, zoomRoot);
            if (!grandParent) continue;
            const parentIdx = grandParent.children.findIndex(c => c.id === parent.id);
            if (parentIdx === -1) continue;
            const moved = ids.length === 1
                ? parent.children.splice(nodeIdx)
                : parent.children.splice(nodeIdx, 1);
            const [node, ...siblings] = moved;
            if (!node) continue;
            if (siblings.length > 0) node.children.push(...siblings);
            const prev = insertCount.get(parent.id) || 0;
            grandParent.children.splice(parentIdx + 1 + prev, 0, node);
            insertCount.set(parent.id, prev + 1);
        }
    }, ids.length > 1 ? applySelectionHighlights : noFocus ? null : () => focusNode(ids[0]));
}

function moveIds(ids, dir) {
    const { zoomRoot } = orderedSelection(ids);
    if (ids.length === 0) return;
    const firstCtx = getNodeCtx(ids[0], zoomRoot);
    if (!firstCtx) return;
    const { parent } = firstCtx;
    const indices = ids.map(id => {
        const ctx = getNodeCtx(id, zoomRoot);
        return (!ctx || ctx.parent !== parent) ? -1 : ctx.idx;
    });
    if (indices.includes(-1)) return;
    indices.sort((a, b) => a - b);
    for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1] + 1) return;
    const [first, last] = [indices[0], indices[indices.length - 1]];
    if (dir === -1 && first === 0) return;
    if (dir === 1 && last === parent.children.length - 1) return;
    mutateDoc(() => {
        moveChild(parent.children, dir === -1 ? first - 1 : last + 1, dir === -1 ? last : first);
    }, ids.length > 1 ? focusSelectionHead : () => focusNode(ids[0]));
}

export function indentNode(id, noFocus = false) { indentIds([id], noFocus); }
export function indentNodes(ids) { indentIds(ids); }
export function unindentNode(id, noFocus = false) { unindentIds([id], noFocus); }
export function unindentNodes(ids) { unindentIds(ids); }
export function moveNode(id, dir) { moveIds([id], dir); }
export function moveNodes(ids, dir) { moveIds(ids, dir); }

export function toggleCollapse(id) {
    const node = findNode(id, State.doc.root);
    if (!node || node.children.length === 0) return;
    mutateDoc(() => { node.collapsed = !node.collapsed; });
}

// ── Search ────────────────────────────────────────────────────────────────────

export function doSearch(query) {
    if (!query.trim()) {
        State.searchMatches = [];
        State.searchIdx = 0;
        byId('search-count').textContent = '';
        render();
        return;
    }
    const q = query.toLowerCase();
    State.searchMatches = collectAllNodes(State.doc.root)
        .filter(n => n.text.toLowerCase().includes(q) || (n.description || '').toLowerCase().includes(q))
        .map(n => n.id);
    State.searchIdx = 0;
    updateSearchCountText();
    render();
    if (State.searchMatches.length > 0) scrollToMatch();
}

export function nextMatch() {
    if (State.searchMatches.length === 0) return;
    State.searchIdx = (State.searchIdx + 1) % State.searchMatches.length;
    updateSearchCountText();
    render();
    scrollToMatch();
}

export function scrollToMatch() {
    const id = State.searchMatches[State.searchIdx];
    document.querySelector(`.bullet-row[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function endSearch() {
    const target = State.searchMatches.length > 0 ? State.searchMatches[State.searchIdx] : null;
    State.searchMatches = [];
    State.searchIdx = 0;
    closeSearch();
    render();
    if (target) requestAnimationFrame(() => focusNode(target));
}

// ── Markdown import ───────────────────────────────────────────────────────────

export function applyMarkdownImport(text) {
    if (!text.trim()) return;
    mutateDoc(() => {
        State.doc.root.children = importMarkdown(text).children;
        State.zoomStack = [];
    });
}

// ── Keyboard handler ──────────────────────────────────────────────────────────

export function handleBulletKey(e, node) {
    if (isPlainKey(e, 'Escape')) {
        e.preventDefault(); clearSelection(); e.target.blur(); return;
    }
    if (e.shiftKey && (isArrowKey(e, 'ArrowUp') || isArrowKey(e, 'ArrowDown'))) {
        e.preventDefault(); extendSelection(node.id, e.key === 'ArrowUp' ? -1 : 1); return;
    }
    if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        const row = document.querySelector(`.bullet-row[data-id="${node.id}"]`);
        if (row) { showDescEditor(row); row.querySelector('.bullet-desc').focus(); }
        return;
    }
    if (isCmdKey(e, ' ')) {
        e.preventDefault();
        if (node.children.length > 0) toggleCollapse(node.id);
        return;
    }
    if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault(); syncNodeTextFromDom(node); State.saveDoc(); zoomInto(node.id); return;
    }
    if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault(); zoomOut(); return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        runOnTarget(node.id, ids => moveIds(ids, dir));
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        runOnTarget(node.id, ids => (e.shiftKey ? unindentIds(ids) : indentIds(ids)));
        return;
    }
    if (isPlainKey(e, 'Enter')) {
        e.preventDefault(); syncNodeTextFromDom(node); newBulletAfter(node.id); return;
    }
    if (isCmdKey(e, 'Backspace')) {
        e.preventDefault(); syncNodeTextFromDom(node);
        runOnTarget(node.id, deleteIds);
        return;
    }
    if (isCmdKey(e, 'c') && State.selectedIds.length > 1) {
        e.preventDefault(); copySelectionAsMarkdown(State.selectedIds); return;
    }
    if (e.key === 'Backspace') {
        const text = getBulletTextEl(node.id)?.textContent ?? node.text;
        if (text === '' && node.description === '') { e.preventDefault(); deleteNode(node.id); return; }
    }
    if (isArrowNoMods(e, 'ArrowUp') || isArrowNoMods(e, 'ArrowDown')) {
        e.preventDefault(); clearSelection();
        e.key === 'ArrowUp' ? focusPrev(node.id) : focusNext(node.id);
        return;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const el = getBulletTextEl(node.id);
        if (el?.textContent === '') { e.preventDefault(); openModal('modal-shortcuts'); }
        return;
    }
    if (isCmdKey(e, 'f')) { e.preventDefault(); openSearch(); return; }
    if (isCmdKey(e, 'z')) { e.preventDefault(); undo(); return; }
}
