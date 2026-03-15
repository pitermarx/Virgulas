// ── Update ────────────────────────────────────────────────────────────────────
// Central message-driven state transitions.

import {
    makeDoc,
    makeNode,
    seedDoc,
    findNode,
    flatVisible,
    findParentInSubtree,
    collectAllNodes,
    importMarkdown,
    exportMarkdown,
} from './model.js';
import State from './state.js';

const DIR_PREV = -1;
const DIR_NEXT = 1;

function hashForZoomStack(stack = State.zoomStack) {
    return stack.length ? '#/' + stack.join('/') : '#';
}

function clearLoginFeedback() {
    State.loginError = '';
    State.loginSuccess = '';
}

function clearConflictState() {
    State.conflictLocal = null;
    State.conflictRemote = null;
    State.conflictResolved = null;
    State.conflictServerVersion = 0;
}

function clearSelectionState() {
    State.selectedIds = [];
    State.selectionAnchor = null;
    State.selectionHead = null;
}

function markDocPending() {
    State.pendingSync = true;
    if (['idle', 'online', 'synced'].includes(State.syncStatus)) State.syncStatus = 'pending';
}

function persistDoc() {
    markDocPending();
    State.saveDoc();
}

function persistDocLocal() {
    State.saveDocLocal();
}

function syncDraftText(id, text) {
    if (!id || typeof text !== 'string') return false;
    const node = findNode(id, State.doc.root);
    if (!node) return false;
    if (node.text === text) return false;
    node.text = text;
    return true;
}

function getNodeCtx(id, zoomRoot = State.getZoomRoot()) {
    const parent = findParentInSubtree(id, zoomRoot);
    if (!parent) return null;
    const idx = parent.children.findIndex(child => child.id === id);
    return idx === -1 ? null : { zoomRoot, parent, idx, node: parent.children[idx] };
}

function orderedIds(ids, flat) {
    const index = new Map(flat.map((entry, idx) => [entry.node.id, idx]));
    return [...ids]
        .map(id => ({ id, fi: index.get(id) }))
        .filter(entry => Number.isInteger(entry.fi))
        .sort((a, b) => a.fi - b.fi);
}

function orderedSelection(ids, zoomRoot = State.getZoomRoot()) {
    const flat = flatVisible(zoomRoot);
    return { zoomRoot, flat, ordered: orderedIds(ids, flat) };
}

function moveChild(children, from, to) {
    children.splice(to, 0, children.splice(from, 1)[0]);
}

function runDocMutation(mutator, { pushUndo = true, persist = true } = {}) {
    if (pushUndo) State.pushUndo();
    const result = mutator();
    State.sanitizeZoomStack();
    if (persist) persistDoc();
    return result;
}

function focusEffect(id, cursor = 'end') {
    return id ? [{ type: 'focus-bullet', id, cursor }] : [];
}

function setSyncedSnapshot(doc, version) {
    State.replaceDoc(doc, { save: true });
    State.pendingSync = false;
    State.syncPaused = false;
    State.updateSyncSnapshot(version);
    State.syncStatus = 'synced';
}

function resetStateAfterSignOut() {
    const doc = makeDoc();
    seedDoc(doc);
    State.replaceDoc(doc, { save: true });
    State.zoomStack = [];
    State.focusedId = null;
    State.searchMatches = [];
    State.searchIdx = 0;
    State.searchOpen = false;
    State.searchQuery = '';
    State.markdownDraft = '';
    State.currentUser = null;
    State.encryptionKey = null;
    State.pendingSync = false;
    State.lastSyncedVersion = 0;
    State.lastSyncedDocJson = null;
    State.syncStatus = 'idle';
    State.syncPaused = false;
    State.loginMode = 'signin';
    State.activeModal = State.activeModal === 'modal-options' ? 'modal-options' : null;
    State.devMode = false;
    clearLoginFeedback();
    clearConflictState();
    clearSelectionState();
}

function updateSearchMatches(query) {
    State.searchQuery = query;
    if (!query.trim()) {
        State.searchMatches = [];
        State.searchIdx = 0;
        return;
    }

    const lower = query.toLowerCase();
    State.searchMatches = collectAllNodes(State.doc.root)
        .filter(node => node.text.toLowerCase().includes(lower) || (node.description || '').toLowerCase().includes(lower))
        .map(node => node.id);
    State.searchIdx = 0;
}

function extendSelection(currentId, dir) {
    const flat = flatVisible(State.getZoomRoot());
    if (!State.selectionAnchor) {
        State.selectionAnchor = currentId;
        State.selectionHead = currentId;
    }

    const headIdx = flat.findIndex(entry => entry.node.id === State.selectionHead);
    if (headIdx === -1) return null;
    const nextIdx = headIdx + dir;
    if (nextIdx < 0 || nextIdx >= flat.length) return null;

    State.selectionHead = flat[nextIdx].node.id;
    const anchorIdx = flat.findIndex(entry => entry.node.id === State.selectionAnchor);
    const selectionHeadIdx = flat.findIndex(entry => entry.node.id === State.selectionHead);
    State.selectedIds = flat
        .slice(Math.min(anchorIdx, selectionHeadIdx), Math.max(anchorIdx, selectionHeadIdx) + 1)
        .map(entry => entry.node.id);
    return State.selectionHead;
}

function selectionOrSingle(nodeId) {
    return State.selectedIds.length > 1 ? [...State.selectedIds] : [nodeId];
}

function deleteIds(ids, { skipConfirm = false } = {}) {
    const { zoomRoot, flat, ordered } = orderedSelection(ids);
    if (ordered.length === 0) return { effects: [] };

    const nodes = ordered.map(entry => findNode(entry.id, zoomRoot)).filter(Boolean);
    const withChildren = nodes.filter(node => node.children.length > 0);
    const label = ids.length === 1
        ? (nodes[0]?.text ? `"${nodes[0].text}"` : 'this bullet')
        : `${ordered.length} bullet(s)`;

    if (!skipConfirm && withChildren.length > 0) {
        return {
            effects: [{
                type: 'confirm-delete',
                message: `Delete ${label}${ids.length === 1 ? ` and its ${withChildren[0].children.length} child item(s)?` : ' and their children?'}`,
                ids,
            }]
        };
    }

    let focusTarget = null;
    for (let idx = ordered[0].fi - 1; idx >= 0; idx -= 1) {
        if (!ids.includes(flat[idx].node.id)) {
            focusTarget = flat[idx].node.id;
            break;
        }
    }

    runDocMutation(() => {
        for (const { id } of [...ordered].reverse()) {
            const parent = findParentInSubtree(id, zoomRoot);
            if (!parent) continue;
            const index = parent.children.findIndex(child => child.id === id);
            if (index !== -1) parent.children.splice(index, 1);
        }
    });

    if (ids.length > 1) clearSelectionState();
    State.focusedId = focusTarget;
    return { effects: focusEffect(focusTarget) };
}

function indentIds(ids, noFocus = false) {
    const { zoomRoot, ordered } = orderedSelection(ids);
    const canIndent = ordered.some(({ id }) => {
        const ctx = getNodeCtx(id, zoomRoot);
        return ctx && ctx.idx > 0;
    });

    if (canIndent) {
        runDocMutation(() => {
            for (const { id } of ordered) {
                const ctx = getNodeCtx(id, zoomRoot);
                if (!ctx || ctx.idx === 0) continue;

                const { parent, idx, node } = ctx;
                const previous = parent.children[idx - 1];
                if (!previous || previous === node) continue;

                parent.children.splice(idx, 1);
                previous.collapsed = false;
                previous.children.push(node);
            }
        });
    }

    if (ids.length > 1) return { effects: focusEffect(State.selectionHead || ids[0]) };
    if (noFocus) return { effects: [] };
    return { effects: focusEffect(ids[0]) };
}

function unindentIds(ids, noFocus = false) {
    const { zoomRoot, ordered } = orderedSelection(ids);
    const canUnindent = ordered.some(({ id }) => {
        const ctx = getNodeCtx(id, zoomRoot);
        return !!(ctx && ctx.parent !== zoomRoot && findParentInSubtree(ctx.parent.id, zoomRoot));
    });

    if (canUnindent) {
        runDocMutation(() => {
            const insertCount = new Map();
            for (const { id } of ordered) {
                const ctx = getNodeCtx(id, zoomRoot);
                if (!ctx || ctx.parent === zoomRoot) continue;

                const { parent, idx: nodeIdx } = ctx;
                const grandParent = findParentInSubtree(parent.id, zoomRoot);
                if (!grandParent) continue;

                const parentIdx = grandParent.children.findIndex(child => child.id === parent.id);
                if (parentIdx === -1) continue;

                const moved = ids.length === 1
                    ? parent.children.splice(nodeIdx)
                    : parent.children.splice(nodeIdx, 1);
                const [node, ...siblings] = moved;
                if (!node) continue;

                if (siblings.length > 0) node.children.push(...siblings);

                const previousInsertions = insertCount.get(parent.id) || 0;
                grandParent.children.splice(parentIdx + 1 + previousInsertions, 0, node);
                insertCount.set(parent.id, previousInsertions + 1);
            }
        });
    }

    if (ids.length > 1) return { effects: focusEffect(State.selectionHead || ids[0]) };
    if (noFocus) return { effects: [] };
    return { effects: focusEffect(ids[0]) };
}

function moveIds(ids, dir) {
    const { zoomRoot } = orderedSelection(ids);
    if (ids.length === 0) return { effects: [] };

    const firstCtx = getNodeCtx(ids[0], zoomRoot);
    if (!firstCtx) return { effects: [] };

    const { parent } = firstCtx;
    const indices = ids.map(id => {
        const ctx = getNodeCtx(id, zoomRoot);
        return (!ctx || ctx.parent !== parent) ? -1 : ctx.idx;
    });

    if (indices.includes(-1)) return { effects: [] };
    indices.sort((a, b) => a - b);
    for (let idx = 1; idx < indices.length; idx += 1) {
        if (indices[idx] !== indices[idx - 1] + 1) return { effects: [] };
    }

    const first = indices[0];
    const last = indices[indices.length - 1];
    if (dir === DIR_PREV && first === 0) return { effects: [] };
    if (dir === DIR_NEXT && last === parent.children.length - 1) return { effects: [] };

    runDocMutation(() => {
        moveChild(parent.children, dir === DIR_PREV ? first - 1 : last + 1, dir === DIR_PREV ? last : first);
    });

    if (ids.length > 1) return { effects: State.selectionHead ? focusEffect(State.selectionHead) : [] };
    return { effects: focusEffect(ids[0]) };
}

function applySyncResult(result) {
    if (!result || result.kind === 'skip') return { effects: [] };

    if (result.kind === 'error') {
        State.syncPaused = false;
        State.syncStatus = 'error';
        return { effects: [] };
    }

    if (result.kind === 'status') {
        State.syncPaused = false;
        State.syncStatus = result.status;
        return result.status === 'synced' ? { effects: [{ type: 'schedule-online' }] } : { effects: [] };
    }

    if (result.kind === 'pushed') {
        setSyncedSnapshot(result.doc, result.version);
        clearConflictState();
        return { effects: [{ type: 'schedule-online' }] };
    }

    if (result.kind === 'pulled') {
        setSyncedSnapshot(result.doc, result.version);
        return { effects: [{ type: 'schedule-online' }] };
    }

    if (result.kind === 'merged-pushed') {
        setSyncedSnapshot(result.doc, result.version);
        return { effects: [{ type: 'schedule-online' }] };
    }

    if (result.kind === 'conflict') {
        State.syncPaused = true;
        State.syncStatus = 'conflict';
        State.conflictLocal = result.local;
        State.conflictRemote = result.remote;
        State.conflictResolved = result.local;
        State.conflictServerVersion = result.serverVersion;
        State.activeModal = 'modal-conflict';
        return { effects: [] };
    }

    return { effects: [] };
}

export function syncSnapshot() {
    return {
        doc: State.doc,
        encryptionKey: State.encryptionKey,
        lastSyncedVersion: State.lastSyncedVersion,
        lastSyncedDocJson: State.lastSyncedDocJson,
        pendingSync: State.pendingSync,
        syncPaused: State.syncPaused,
    };
}

export function update(msg) {
    switch (msg.type) {
        case 'INIT_LOCAL_DOC': {
            if (!State.loadDoc()) {
                seedDoc(State.doc);
                persistDocLocal();
            }
            State.loadFromHash();
            return { effects: [] };
        }

        case 'SET_FOCUSED': {
            State.focusedId = msg.id;
            return { effects: [] };
        }

        case 'CLEAR_SELECTION': {
            clearSelectionState();
            return { effects: [] };
        }

        case 'EXTEND_SELECTION': {
            const nextId = extendSelection(msg.id, msg.dir);
            if (!nextId) return { effects: [] };
            return { effects: focusEffect(nextId) };
        }

        case 'OPEN_SEARCH': {
            State.searchOpen = true;
            return { effects: [{ type: 'focus-search' }] };
        }

        case 'SEARCH_QUERY_CHANGED': {
            updateSearchMatches(msg.query);
            return State.searchMatches.length > 0 ? { effects: [{ type: 'scroll-match' }] } : { effects: [] };
        }

        case 'SEARCH_NEXT': {
            if (State.searchMatches.length === 0) return { effects: [] };
            State.searchIdx = (State.searchIdx + 1) % State.searchMatches.length;
            return { effects: [{ type: 'scroll-match' }] };
        }

        case 'CLOSE_SEARCH': {
            const target = State.searchMatches.length > 0 ? State.searchMatches[State.searchIdx] : null;
            State.searchOpen = false;
            State.searchQuery = '';
            State.searchMatches = [];
            State.searchIdx = 0;
            return target ? { effects: focusEffect(target) } : { effects: [] };
        }

        case 'OPEN_MODAL': {
            State.activeModal = msg.id;
            return { effects: [] };
        }

        case 'OPEN_LOGIN_MODAL': {
            State.activeModal = 'modal-login';
            State.loginMode = 'signin';
            clearLoginFeedback();
            return { effects: [] };
        }

        case 'CLOSE_MODAL': {
            if (!msg.id || State.activeModal === msg.id) State.activeModal = null;
            return { effects: [] };
        }

        case 'OPEN_MARKDOWN_MODAL': {
            State.markdownDraft = exportMarkdown(State.doc.root).trim();
            State.activeModal = 'modal-markdown';
            return { effects: [{ type: 'focus-markdown' }] };
        }

        case 'UPDATE_MARKDOWN_DRAFT': {
            State.markdownDraft = msg.text;
            return { effects: [] };
        }

        case 'APPLY_MARKDOWN_IMPORT': {
            if (!msg.text.trim()) return { effects: [] };
            runDocMutation(() => {
                State.doc.root.children = importMarkdown(msg.text).children;
                State.zoomStack = [];
            });
            State.activeModal = null;
            return { effects: [{ type: 'replace-hash', hash: hashForZoomStack([]) }] };
        }

        case 'TOGGLE_LOGIN_MODE': {
            State.loginMode = State.loginMode === 'signin' ? 'signup' : 'signin';
            clearLoginFeedback();
            return { effects: [] };
        }

        case 'LOGIN_REQUEST': {
            clearLoginFeedback();
            return { effects: [{ type: 'login-submit', payload: msg.payload }] };
        }

        case 'LOGIN_RESULT': {
            const result = msg.result;
            if (!result) return { effects: [] };
            if (result.kind === 'error') {
                State.loginError = result.message;
                State.loginSuccess = '';
                return { effects: [] };
            }
            if (result.kind === 'info') {
                State.loginError = '';
                State.loginSuccess = result.message;
                return { effects: [] };
            }
            if (result.kind === 'signed-in') {
                State.currentUser = result.user;
                State.encryptionKey = result.encryptionKey;
                State.activeModal = 'modal-options';
                clearLoginFeedback();
                if (result.serverDoc) {
                    setSyncedSnapshot(result.serverDoc, result.serverVersion);
                } else {
                    State.lastSyncedVersion = 0;
                    State.lastSyncedDocJson = null;
                    markDocPending();
                }
                return { effects: [{ type: 'start-sync-loop' }, { type: 'sync-now' }] };
            }
            return { effects: [] };
        }

        case 'AUTH_READY': {
            const result = msg.result;
            if (!result) return { effects: [] };
            if (result.kind === 'signed-out-missing-password') {
                resetStateAfterSignOut();
                return { effects: [{ type: 'stop-sync-loop' }, { type: 'replace-hash', hash: hashForZoomStack([]) }] };
            }

            State.currentUser = result.user;
            State.encryptionKey = result.encryptionKey;
            if (!result.user) {
                State.syncStatus = 'idle';
                return { effects: [{ type: 'stop-sync-loop' }] };
            }
            return { effects: [{ type: 'start-sync-loop' }, { type: 'sync-now' }] };
        }

        case 'AUTH_SESSION_CHANGED': {
            State.currentUser = msg.user;
            if (!msg.user) {
                State.encryptionKey = null;
                State.syncStatus = 'idle';
                return { effects: [{ type: 'stop-sync-loop' }] };
            }
            return State.encryptionKey ? { effects: [{ type: 'start-sync-loop' }] } : { effects: [] };
        }

        case 'SIGN_OUT_REQUEST': {
            return { effects: [{ type: 'sign-out' }] };
        }

        case 'SIGNED_OUT': {
            resetStateAfterSignOut();
            return { effects: [{ type: 'stop-sync-loop' }, { type: 'replace-hash', hash: hashForZoomStack([]) }] };
        }

        case 'DELETE_ACCOUNT_REQUEST': {
            return { effects: [{ type: 'delete-account' }] };
        }

        case 'DELETE_ACCOUNT_FAILED': {
            return { effects: [{ type: 'toast', message: 'Failed to delete account data. Please try again.' }] };
        }

        case 'SYNC_REQUEST': {
            if (State.syncPaused || !State.encryptionKey) return { effects: [] };
            State.syncStatus = 'syncing';
            return { effects: [{ type: 'sync-now' }] };
        }

        case 'SYNC_RESULT': {
            return applySyncResult(msg.result);
        }

        case 'SYNC_ONLINE': {
            if (State.syncStatus === 'synced') State.syncStatus = 'online';
            return { effects: [] };
        }

        case 'CONFLICT_UPDATE_RESOLVED': {
            State.conflictResolved = msg.text;
            return { effects: [] };
        }

        case 'CONFLICT_USE_LOCAL': {
            State.activeModal = null;
            State.syncPaused = false;
            return { effects: [{ type: 'push-resolved-doc', baseServerVersion: State.conflictServerVersion }] };
        }

        case 'CONFLICT_USE_REMOTE': {
            State.activeModal = null;
            State.syncPaused = false;
            if (State.conflictRemote) {
                State.doc.root.children = importMarkdown(State.conflictRemote).children;
                State.sanitizeZoomStack();
                persistDocLocal();
            }
            State.updateSyncSnapshot(State.conflictServerVersion);
            State.pendingSync = false;
            State.syncStatus = 'synced';
            clearConflictState();
            return { effects: [{ type: 'schedule-online' }] };
        }

        case 'CONFLICT_APPLY': {
            if (!msg.text.trim()) return { effects: [] };
            State.conflictResolved = msg.text;
            State.doc.root.children = importMarkdown(msg.text).children;
            State.sanitizeZoomStack();
            persistDocLocal();
            State.activeModal = null;
            State.syncPaused = false;
            return { effects: [{ type: 'push-resolved-doc', baseServerVersion: State.conflictServerVersion }] };
        }

        case 'COMMIT_BULLET_TEXT': {
            const node = findNode(msg.id, State.doc.root);
            if (!node) return { effects: [] };
            if (!msg.changed) {
                node.text = msg.text;
                return { effects: [] };
            }
            runDocMutation(() => {
                node.text = msg.text;
            });
            return { effects: [] };
        }

        case 'COMMIT_BULLET_DESC': {
            const node = findNode(msg.id, State.doc.root);
            if (!node) return { effects: [] };
            if (!msg.changed) {
                node.description = msg.text;
                return { effects: [] };
            }
            runDocMutation(() => {
                node.description = msg.text;
            });
            return { effects: [] };
        }

        case 'COMMIT_ZOOM_DESC': {
            const zoomRoot = State.getZoomRoot();
            if (!zoomRoot || State.zoomStack.length === 0) return { effects: [] };
            if (!msg.changed) {
                zoomRoot.description = msg.text;
                return { effects: [] };
            }
            runDocMutation(() => {
                zoomRoot.description = msg.text;
            });
            return { effects: [] };
        }

        case 'APPEND_GHOST': {
            const trimmed = msg.text.trim();
            if (!trimmed) return { effects: [] };
            runDocMutation(() => {
                State.getZoomRoot().children.push(makeNode(trimmed));
            });
            return { effects: [] };
        }

        case 'CREATE_AFTER': {
            syncDraftText(msg.id, msg.text);
            const ctx = getNodeCtx(msg.id);
            if (!ctx) return { effects: [] };
            const created = runDocMutation(() => {
                const next = makeNode('');
                if (!ctx.node.collapsed && ctx.node.children.length > 0) ctx.node.children.unshift(next);
                else ctx.parent.children.splice(ctx.idx + 1, 0, next);
                return next;
            });
            return { effects: focusEffect(created?.id) };
        }

        case 'DELETE_TARGET': {
            syncDraftText(msg.id, msg.text);
            return deleteIds(selectionOrSingle(msg.id));
        }

        case 'CONFIRMED_DELETE': {
            return deleteIds(msg.ids || [], { skipConfirm: true });
        }

        case 'COPY_SELECTION': {
            if (State.selectedIds.length <= 1) return { effects: [] };
            const zoomRoot = State.getZoomRoot();
            const flat = flatVisible(zoomRoot);
            const nodes = orderedIds(State.selectedIds, flat)
                .map(entry => findNode(entry.id, zoomRoot))
                .filter(Boolean);
            const topLevel = nodes.filter(node => !nodes.some(other => other !== node && findNode(node.id, other)));
            return {
                effects: [
                    { type: 'copy-markdown', text: exportMarkdown({ children: topLevel }).trim() },
                    { type: 'toast', message: 'Markdown copied' },
                ]
            };
        }

        case 'INDENT_TARGET': {
            syncDraftText(msg.id, msg.text);
            return indentIds(selectionOrSingle(msg.id), !!msg.noFocus);
        }

        case 'UNINDENT_TARGET': {
            syncDraftText(msg.id, msg.text);
            return unindentIds(selectionOrSingle(msg.id), !!msg.noFocus);
        }

        case 'MOVE_TARGET': {
            syncDraftText(msg.id, msg.text);
            return moveIds(selectionOrSingle(msg.id), msg.dir);
        }

        case 'TOGGLE_COLLAPSE': {
            const node = findNode(msg.id, State.doc.root);
            if (!node || node.children.length === 0) return { effects: [] };
            runDocMutation(() => {
                node.collapsed = !node.collapsed;
            });
            return { effects: focusEffect(msg.id) };
        }

        case 'ZOOM_IN': {
            const changed = syncDraftText(msg.id, msg.text);
            if (changed) persistDoc();
            State.zoomStack.push(msg.id);
            State.focusedId = null;
            return { effects: [{ type: 'push-hash', hash: hashForZoomStack() }, { type: 'focus-zoom-desc' }] };
        }

        case 'ZOOM_OUT': {
            if (State.zoomStack.length === 0) return { effects: [] };
            const previousId = State.zoomStack.pop();
            State.focusedId = previousId;
            return { effects: [{ type: 'push-hash', hash: hashForZoomStack() }, ...focusEffect(previousId)] };
        }

        case 'ZOOM_TO': {
            State.zoomStack = msg.stack;
            State.focusedId = null;
            return { effects: [{ type: 'push-hash', hash: hashForZoomStack() }] };
        }

        case 'RESTORE_HASH': {
            State.loadFromHash();
            return { effects: [] };
        }

        case 'UNDO': {
            if (State.undoStack.length === 0) return { effects: [] };
            State.replaceDoc(JSON.parse(State.undoStack.pop()));
            persistDoc();
            return { effects: [] };
        }

        default:
            return { effects: [] };
    }
}
