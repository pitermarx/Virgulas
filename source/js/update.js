// ── Update ────────────────────────────────────────────────────────────────────
// State-modifying operations: the "Update" layer in the Elm-inspired
// architecture. These functions apply a change to the state and re-render.

import { makeNode, findNode, flatVisible, findParentInSubtree, collectAllNodes, importMarkdown, exportMarkdown } from './model.js';
import * as State from './state.js';
import { render, setSyncStatus, openSearch, closeSearch, openModal, showToast } from './view.js';

// ── Cursor helpers ────────────────────────────────────────────────────────────

function moveCursorToEnd(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function moveCursorToStart(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

// ── Focus helpers ─────────────────────────────────────────────────────────────

export function focusNode(id, toEnd = true) {
    State.setFocusedId(id);
    const el = document.querySelector(`.bullet-text[data-id="${id}"]`);
    if (!el) return;
    el.focus();
    if (toEnd) moveCursorToEnd(el);
}

export function focusNodeAtStart(id) {
    State.setFocusedId(id);
    const el = document.querySelector(`.bullet-text[data-id="${id}"]`);
    if (!el) return;
    el.focus();
    moveCursorToStart(el);
}

export function focusPrev(id) {
    const flat = flatVisible(State.getZoomRoot());
    const idx = flat.findIndex(x => x.node.id === id);
    if (idx <= 0) {
        if (State.zoomStack.length > 0) document.getElementById('zoom-desc').focus();
        return;
    }
    focusNode(flat[idx - 1].node.id);
}

export function focusNext(id) {
    const flat = flatVisible(State.getZoomRoot());
    const idx = flat.findIndex(x => x.node.id === id);
    if (idx === -1) return;
    if (idx >= flat.length - 1) {
        const ghostText = document.getElementById('ghost-text');
        if (ghostText) ghostText.focus();
        return;
    }
    focusNodeAtStart(flat[idx + 1].node.id);
}

// ── Selection ─────────────────────────────────────────────────────────────────

export function clearSelection() {
    State.setSelectedIds([]);
    State.setSelectionAnchor(null);
    State.setSelectionHead(null);
    document.querySelectorAll('.bullet-row.selected').forEach(el => el.classList.remove('selected'));
}

export function applySelectionHighlights() {
    document.querySelectorAll('.bullet-row.selected').forEach(el => el.classList.remove('selected'));
    State.selectedIds.forEach(id => {
        const el = document.querySelector(`.bullet-row[data-id="${id}"]`);
        if (el) el.classList.add('selected');
    });
}

export function extendSelection(currentId, dir) {
    const flat = flatVisible(State.getZoomRoot());
    if (!State.selectionAnchor) {
        State.setSelectionAnchor(currentId);
        State.setSelectionHead(currentId);
    }
    const headIdx = flat.findIndex(x => x.node.id === State.selectionHead);
    if (headIdx === -1) return;
    const newHeadIdx = headIdx + dir;
    if (newHeadIdx < 0 || newHeadIdx >= flat.length) return;
    State.setSelectionHead(flat[newHeadIdx].node.id);
    const newAnchorIdx = flat.findIndex(x => x.node.id === State.selectionAnchor);
    const newHeadFlatIdx = flat.findIndex(x => x.node.id === State.selectionHead);
    const from = Math.min(newAnchorIdx, newHeadFlatIdx);
    const to = Math.max(newAnchorIdx, newHeadFlatIdx);
    State.setSelectedIds(flat.slice(from, to + 1).map(x => x.node.id));
    applySelectionHighlights();
    State.setKeepSelection(true);
    focusNode(State.selectionHead);
    State.setKeepSelection(false);
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

export function zoomInto(id) {
    State.zoomStack.push(id);
    State.setFocusedId(null);
    State.updateHash();
    render();
    requestAnimationFrame(() => {
        document.getElementById('zoom-desc').focus();
    });
}

export function zoomOut() {
    if (State.zoomStack.length === 0) return;
    const prevId = State.zoomStack[State.zoomStack.length - 1];
    State.zoomStack.pop();
    State.setFocusedId(prevId);
    State.updateHash();
    render();
    requestAnimationFrame(() => focusNode(prevId));
}

export function zoomTo(stack) {
    State.setZoomStack(stack);
    State.setFocusedId(null);
    State.updateHash();
    render();
}

// ── Undo ──────────────────────────────────────────────────────────────────────

export function undo() {
    if (State.undoStack.length === 0) return;
    const prev = State.undoStack.pop();
    State.setDoc(JSON.parse(prev));
    State.saveDoc();
    State.setZoomStack(State.zoomStack.filter(id => !!findNode(id, State.doc.root)));
    render();
}

// ── Node operations ───────────────────────────────────────────────────────────

export function newBulletAfter(id) {
    const zoomRoot = State.getZoomRoot();
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent) return;
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx === -1) return;
    const node = parent.children[idx];
    const newNode = makeNode('');
    State.pushUndo();
    if (!node.collapsed && node.children.length > 0) {
        node.children.unshift(newNode);
    } else {
        parent.children.splice(idx + 1, 0, newNode);
    }
    State.saveDoc();
    render();
    requestAnimationFrame(() => focusNode(newNode.id, false));
}

export function deleteNode(id) {
    const zoomRoot = State.getZoomRoot();
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent) return;
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx === -1) return;
    const node = parent.children[idx];

    if (node.children.length > 0) {
        const label = node.text ? `"${node.text}"` : 'this bullet';
        if (!window.confirm(`Delete ${label} and its ${node.children.length} child item(s)?`)) {
            return;
        }
    }

    let focusTarget = null;
    if (idx > 0) {
        focusTarget = parent.children[idx - 1].id;
    } else if (parent !== zoomRoot) {
        focusTarget = parent.id;
    }

    State.pushUndo();
    parent.children.splice(idx, 1);
    State.saveDoc();
    State.setFocusedId(focusTarget);
    render();
    if (focusTarget) {
        requestAnimationFrame(() => focusNode(focusTarget));
    }
}

export function deleteNodes(ids) {
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);

    const ordered = [...ids]
        .map(id => ({ id, flatIdx: flat.findIndex(x => x.node.id === id) }))
        .filter(x => x.flatIdx >= 0)
        .sort((a, b) => a.flatIdx - b.flatIdx);

    if (ordered.length === 0) return;

    const nodes = ordered.map(x => findNode(x.id, zoomRoot)).filter(Boolean);
    const nodesWithChildren = nodes.filter(n => n.children.length > 0);
    if (nodesWithChildren.length > 0) {
        if (!window.confirm(`Delete ${ordered.length} bullet(s) and their children?`)) return;
    }

    const firstFlatIdx = ordered[0].flatIdx;
    let focusTarget = null;
    for (let i = firstFlatIdx - 1; i >= 0; i--) {
        if (!ids.includes(flat[i].node.id)) {
            focusTarget = flat[i].node.id;
            break;
        }
    }

    State.pushUndo();
    for (const { id } of [...ordered].reverse()) {
        const parent = findParentInSubtree(id, zoomRoot);
        if (!parent) continue;
        const idx = parent.children.findIndex(c => c.id === id);
        if (idx !== -1) parent.children.splice(idx, 1);
    }
    clearSelection();
    State.saveDoc();
    State.setFocusedId(focusTarget);
    render();
    if (focusTarget) {
        requestAnimationFrame(() => focusNode(focusTarget));
    }
}

export function copySelectionAsMarkdown(ids) {
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);
    const orderedIds = [...ids].sort((a, b) =>
        flat.findIndex(x => x.node.id === a) - flat.findIndex(x => x.node.id === b)
    );
    const nodes = orderedIds.map(id => findNode(id, zoomRoot)).filter(Boolean);
    const topLevelNodes = nodes.filter(node => !nodes.some(other => other !== node && findNode(node.id, other)));
    const md = exportMarkdown({ children: topLevelNodes }).trim();
    navigator.clipboard.writeText(md).then(() => {
        showToast('Markdown copied');
    }).catch(() => {
        showToast('Copy failed');
    });
}

export function indentNode(id) {
    const zoomRoot = State.getZoomRoot();
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent) return;
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx === 0) return;
    const node = parent.children[idx];
    const prevSibling = parent.children[idx - 1];
    State.pushUndo();
    parent.children.splice(idx, 1);
    prevSibling.collapsed = false;
    prevSibling.children.push(node);
    State.saveDoc();
    render();
    requestAnimationFrame(() => focusNode(id));
}

export function unindentNode(id) {
    const zoomRoot = State.getZoomRoot();
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent || parent === zoomRoot) return;
    const grandParent = findParentInSubtree(parent.id, zoomRoot);
    if (!grandParent) return;
    const nodeIdx = parent.children.findIndex(c => c.id === id);
    const parentIdx = grandParent.children.findIndex(c => c.id === parent.id);
    if (nodeIdx === -1 || parentIdx === -1) return;
    State.pushUndo();
    const [node, ...siblingsToAdopt] = parent.children.splice(nodeIdx);
    node.children.push(...siblingsToAdopt);
    grandParent.children.splice(parentIdx + 1, 0, node);
    State.saveDoc();
    render();
    requestAnimationFrame(() => focusNode(id));
}

export function moveNode(id, dir) {
    const zoomRoot = State.getZoomRoot();
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent) return;
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx === -1) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= parent.children.length) return;
    State.pushUndo();
    const [node] = parent.children.splice(idx, 1);
    parent.children.splice(newIdx, 0, node);
    State.saveDoc();
    render();
    requestAnimationFrame(() => focusNode(id));
}

export function indentNodes(ids) {
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);
    const ordered = [...ids].sort((a, b) =>
        flat.findIndex(x => x.node.id === a) - flat.findIndex(x => x.node.id === b)
    );
    State.pushUndo();
    for (const id of ordered) {
        const parent = findParentInSubtree(id, zoomRoot);
        if (!parent) continue;
        const idx = parent.children.findIndex(c => c.id === id);
        if (idx === 0) continue;
        const node = parent.children[idx];
        const prevSibling = parent.children[idx - 1];
        parent.children.splice(idx, 1);
        prevSibling.collapsed = false;
        prevSibling.children.push(node);
    }
    State.saveDoc();
    render();
    requestAnimationFrame(() => applySelectionHighlights());
}

export function unindentNodes(ids) {
    const zoomRoot = State.getZoomRoot();
    const flat = flatVisible(zoomRoot);
    const ordered = [...ids].sort((a, b) =>
        flat.findIndex(x => x.node.id === a) - flat.findIndex(x => x.node.id === b)
    );
    State.pushUndo();
    const insertCountByParent = new Map();
    for (const id of ordered) {
        const parent = findParentInSubtree(id, zoomRoot);
        if (!parent || parent === zoomRoot) continue;
        const grandParent = findParentInSubtree(parent.id, zoomRoot);
        if (!grandParent) continue;
        const nodeIdx = parent.children.findIndex(c => c.id === id);
        const parentIdx = grandParent.children.findIndex(c => c.id === parent.id);
        if (nodeIdx === -1 || parentIdx === -1) continue;
        const [node] = parent.children.splice(nodeIdx, 1);
        const prevCount = insertCountByParent.get(parent.id) || 0;
        grandParent.children.splice(parentIdx + 1 + prevCount, 0, node);
        insertCountByParent.set(parent.id, prevCount + 1);
    }
    State.saveDoc();
    render();
    requestAnimationFrame(() => applySelectionHighlights());
}

export function moveNodes(ids, dir) {
    const zoomRoot = State.getZoomRoot();
    if (ids.length === 0) return;
    const parent = findParentInSubtree(ids[0], zoomRoot);
    if (!parent) return;
    const indices = ids.map(id => {
        if (findParentInSubtree(id, zoomRoot) !== parent) return -1;
        return parent.children.findIndex(c => c.id === id);
    });
    if (indices.includes(-1)) return;
    indices.sort((a, b) => a - b);
    for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1] + 1) return;
    }
    const firstIdx = indices[0];
    const lastIdx = indices[indices.length - 1];
    State.pushUndo();
    if (dir === -1) {
        if (firstIdx === 0) return;
        const [nodeToSwap] = parent.children.splice(firstIdx - 1, 1);
        parent.children.splice(lastIdx, 0, nodeToSwap);
    } else {
        if (lastIdx === parent.children.length - 1) return;
        const [nodeToSwap] = parent.children.splice(lastIdx + 1, 1);
        parent.children.splice(firstIdx, 0, nodeToSwap);
    }
    State.saveDoc();
    render();
    requestAnimationFrame(() => {
        applySelectionHighlights();
        State.setKeepSelection(true);
        focusNode(State.selectionHead);
        State.setKeepSelection(false);
    });
}

// ── Search ────────────────────────────────────────────────────────────────────

export function doSearch(query) {
    if (!query.trim()) {
        State.setSearchMatches([]);
        State.setSearchIdx(0);
        document.getElementById('search-count').textContent = '';
        render();
        return;
    }
    const q = query.toLowerCase();
    const all = collectAllNodes(State.doc.root);
    const matches = all
        .filter(n => n.text.toLowerCase().includes(q) || (n.description || '').toLowerCase().includes(q))
        .map(n => n.id);
    State.setSearchMatches(matches);
    State.setSearchIdx(0);
    document.getElementById('search-count').textContent =
        matches.length === 0 ? 'No matches' : `1 / ${matches.length}`;
    render();
    if (matches.length > 0) scrollToMatch();
}

export function nextMatch() {
    if (State.searchMatches.length === 0) return;
    State.setSearchIdx((State.searchIdx + 1) % State.searchMatches.length);
    document.getElementById('search-count').textContent =
        `${State.searchIdx + 1} / ${State.searchMatches.length}`;
    render();
    scrollToMatch();
}

export function scrollToMatch() {
    const id = State.searchMatches[State.searchIdx];
    if (!id) return;
    const el = document.querySelector(`.bullet-row[data-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function endSearch() {
    const focusTarget = State.searchMatches.length > 0 ? State.searchMatches[State.searchIdx] : null;
    State.setSearchMatches([]);
    State.setSearchIdx(0);
    closeSearch();
    render();
    if (focusTarget) {
        requestAnimationFrame(() => focusNode(focusTarget));
    }
}

// ── Apply markdown import ─────────────────────────────────────────────────────

export function applyMarkdownImport(text) {
    if (!text.trim()) return;
    State.pushUndo();
    const newRoot = importMarkdown(text);
    State.doc.root.children = newRoot.children;
    State.setZoomStack([]);
    State.saveDoc();
    render();
}

// ── Keyboard handler ──────────────────────────────────────────────────────────

export function handleBulletKey(e, node) {
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        clearSelection();
        e.target.blur();
        return;
    }

    if (e.shiftKey && e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        extendSelection(node.id, -1);
        return;
    }

    if (e.shiftKey && e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        extendSelection(node.id, 1);
        return;
    }

    if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        const row = document.querySelector(`.bullet-row[data-id="${node.id}"]`);
        if (!row) return;
        const descEl = row.querySelector('.bullet-desc');
        const descView = row.querySelector('.bullet-desc-view');
        descView.classList.remove('visible');
        descEl.classList.add('editing');
        descEl.style.height = 'auto';
        descEl.style.height = descEl.scrollHeight + 'px';
        descEl.focus();
        const end = descEl.value.length;
        descEl.setSelectionRange(end, end);
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
        e.preventDefault();
        if (node.children.length > 0) {
            State.pushUndo();
            node.collapsed = !node.collapsed;
            State.saveDoc();
            render();
            requestAnimationFrame(() => focusNode(node.id));
        }
        return;
    }

    if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        const textEl = document.querySelector(`.bullet-text[data-id="${node.id}"]`);
        if (textEl) node.text = textEl.textContent;
        State.saveDoc();
        zoomInto(node.id);
        return;
    }

    if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        zoomOut();
        return;
    }

    if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        if (State.selectedIds.length > 1) {
            moveNodes(State.selectedIds, -1);
        } else {
            clearSelection();
            moveNode(node.id, -1);
        }
        return;
    }

    if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        if (State.selectedIds.length > 1) {
            moveNodes(State.selectedIds, 1);
        } else {
            clearSelection();
            moveNode(node.id, 1);
        }
        return;
    }

    if (!e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        if (State.selectedIds.length > 1) {
            indentNodes(State.selectedIds);
        } else {
            clearSelection();
            indentNode(node.id);
        }
        return;
    }

    if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        if (State.selectedIds.length > 1) {
            unindentNodes(State.selectedIds);
        } else {
            clearSelection();
            unindentNode(node.id);
        }
        return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const textEl = document.querySelector(`.bullet-text[data-id="${node.id}"]`);
        if (textEl) node.text = textEl.textContent;
        newBulletAfter(node.id);
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Backspace') {
        e.preventDefault();
        const textEl = document.querySelector(`.bullet-text[data-id="${node.id}"]`);
        if (textEl) node.text = textEl.textContent;
        if (State.selectedIds.length > 1) {
            deleteNodes(State.selectedIds);
        } else {
            deleteNode(node.id);
        }
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (State.selectedIds.length > 1) {
            e.preventDefault();
            copySelectionAsMarkdown(State.selectedIds);
        }
        return;
    }

    if (e.key === 'Backspace') {
        const textEl = document.querySelector(`.bullet-text[data-id="${node.id}"]`);
        const currentText = textEl ? textEl.textContent : node.text;
        if (currentText === '' && node.description === '') {
            e.preventDefault();
            deleteNode(node.id);
            return;
        }
    }

    if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        clearSelection();
        focusPrev(node.id);
        return;
    }

    if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        clearSelection();
        focusNext(node.id);
        return;
    }

    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const textEl = document.querySelector(`.bullet-text[data-id="${node.id}"]`);
        if (textEl && textEl.textContent === '') {
            e.preventDefault();
            openModal('modal-shortcuts');
        }
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
        return;
    }
}
