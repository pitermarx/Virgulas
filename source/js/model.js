// ── Model ─────────────────────────────────────────────────────────────────────
// Pure data model functions. No side effects, no DOM, no state mutations.
// This is the "Model" layer in the Elm-inspired architecture.

export function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function renderInline(text) {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="bullet-img">')
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function makeNode(text = '', children = [], description = '') {
    return { id: uid(), text, description, children, collapsed: false };
}

export function makeDoc() {
    const root = makeNode('root');
    return { root, version: 1 };
}

export function seedDoc(doc) {
    const md = [
        '- Press **Enter** to create a new bullet',
        '  > A new bullet is inserted immediately after the current one at the same depth. The cursor moves to it automatically so you can start typing right away.',
        '- Use **Tab** and **Shift+Tab** to indent and unindent',
        '  > Tab makes the current bullet a child of the bullet above it. Shift+Tab promotes it one level up. On mobile, swipe right to indent and swipe left to unindent.',
        '- Use **Alt+↑/↓** to move bullets up and down',
        "  > Reorders siblings without changing their depth or children. Use Ctrl+Space to collapse or expand a bullet's children.",
        '  - Alt+→ to zoom into any bullet',
        '    > Zooming focuses the view on a single node and its subtree. The breadcrumb bar at the top shows your current path and lets you navigate back up.',
        '  - Alt+← to zoom back out',
        '    > Returns to the parent level. You can also press Escape while editing the zoom title, or click any crumb in the breadcrumb bar.',
        '- Press **Shift+Enter** to add a description to any bullet',
        '  > Descriptions appear below the bullet text in a smaller muted font. Press Shift+Enter or Escape from the description to return to the bullet text. Click the description preview to edit it again.',
        '- Use `Ctrl+F` to search your entire outline',
        '  > Search matches both bullet text and descriptions across the whole document, not just the current zoom level. Press Enter to cycle through matches, Escape to close.',
        '- Use `Ctrl+Z` to undo and the **Markdown** button to export',
        '  > Undo reverses the last structural change (create, delete, move, indent). The Markdown toolbar button opens a live editor showing your full outline — edit it directly and click Apply to import changes.',
        '- Images are supported — type an image in markdown syntax in any bullet text',
        '  > Use the standard markdown image syntax: an exclamation mark, then the alt text in square brackets, then the URL in parentheses. The image is rendered below the bullet on blur.',
        '  - ![Virgulas – main view](screenshots/main.png)',
        '  - ![Virgulas – dark mode](screenshots/dark-mode.png)',
    ].join('\n');
    const newRoot = importMarkdown(md);
    doc.root.children = newRoot.children;
}

export function findNode(id, node) {
    if (node.id === id) return node;
    for (const child of node.children) {
        const found = findNode(id, child);
        if (found) return found;
    }
    return null;
}

export function findParent(id, node, parent = null) {
    if (node.id === id) return parent;
    for (const child of node.children) {
        const found = findParent(id, child, node);
        if (found !== undefined) return found;
    }
    return undefined;
}

export function findParentInSubtree(id, subtreeRoot) {
    if (subtreeRoot.id === id) return null;
    for (const child of subtreeRoot.children) {
        if (child.id === id) return subtreeRoot;
        const found = findParentInSubtree(id, child);
        if (found) return found;
    }
    return null;
}

export function flatVisible(zoomRoot, depth = 0, arr = []) {
    for (const child of zoomRoot.children) {
        arr.push({ node: child, depth });
        if (!child.collapsed && child.children.length > 0) {
            flatVisible(child, depth + 1, arr);
        }
    }
    return arr;
}

export function collectAllNodes(root, arr = []) {
    for (const child of root.children) {
        arr.push(child);
        collectAllNodes(child, arr);
    }
    return arr;
}

export function exportMarkdown(node, depth = 0) {
    let out = '';
    for (const child of node.children) {
        const indent = '  '.repeat(depth);
        const bullet = child.collapsed ? '+' : '-';
        out += `${indent}${bullet} ${child.text}\n`;
        if (child.description) {
            for (const line of child.description.split('\n')) {
                out += `${indent}  > ${line}\n`;
            }
        }
        if (child.children.length > 0) {
            out += exportMarkdown(child, depth + 1);
        }
    }
    return out;
}

export function importMarkdown(text) {
    const lines = text.split('\n');
    const root = makeNode('root');
    const stack = [{ node: root, indent: -1 }];

    for (const line of lines) {
        const bulletMatch = line.match(/^(\s*)([-*+])\s(.*)$/);
        if (bulletMatch) {
            const indentLen = bulletMatch[1].length;
            const bulletChar = bulletMatch[2];
            const nodeText = bulletMatch[3];
            const node = makeNode(nodeText);
            node.collapsed = bulletChar === '+';

            while (stack.length > 1 && stack[stack.length - 1].indent >= indentLen) {
                stack.pop();
            }
            stack[stack.length - 1].node.children.push(node);
            stack.push({ node, indent: indentLen });
            continue;
        }
        const descMatch = line.match(/^\s*>\s?(.*)$/);
        if (descMatch && stack.length > 1) {
            const lastNode = stack[stack.length - 1].node;
            lastNode.description = (lastNode.description ? lastNode.description + '\n' : '') + descMatch[1];
        }
    }
    return root;
}

export function buildNodeMap(node, map = {}) {
    map[node.id] = {
        text: node.text || '',
        description: node.description || '',
        collapsed: !!node.collapsed,
        children: (node.children || []).map(c => c.id)
    };
    for (const child of (node.children || [])) {
        buildNodeMap(child, map);
    }
    return map;
}

export function tryAutoMerge(localDoc, remoteDoc, baseDocJson) {
    if (!baseDocJson) return null;
    let baseDoc;
    try { baseDoc = JSON.parse(baseDocJson); } catch { return null; }

    const baseMap = buildNodeMap(baseDoc.root);
    const localMap = buildNodeMap(localDoc.root);
    const remoteMap = buildNodeMap(remoteDoc.root);

    for (const id of Object.keys(baseMap)) {
        const base = baseMap[id];
        const local = localMap[id];
        const remote = remoteMap[id];
        if (!local || !remote) continue;

        if (local.text !== base.text && remote.text !== base.text && local.text !== remote.text) {
            return null;
        }
        if (local.description !== base.description && remote.description !== base.description &&
            local.description !== remote.description) {
            return null;
        }
        const bk = base.children.join(',');
        const lk = local.children.join(',');
        const rk = remote.children.join(',');
        if (lk !== bk && rk !== bk && lk !== rk) {
            return null;
        }
    }

    const merged = JSON.parse(JSON.stringify(localDoc));

    function mergeNode(localNode) {
        const id = localNode.id;
        const base = baseMap[id];
        const remote = remoteMap[id];

        if (base && remote) {
            if (remote.text !== base.text && (localNode.text || '') === base.text) {
                localNode.text = remote.text;
            }
            if (remote.description !== base.description &&
                (localNode.description || '') === base.description) {
                localNode.description = remote.description;
            }
            if (remote.collapsed !== base.collapsed && localNode.collapsed === base.collapsed) {
                localNode.collapsed = remote.collapsed;
            }
            const baseChildSet = new Set(base.children);
            for (const newChildId of remote.children) {
                if (!baseChildSet.has(newChildId) && !localMap[newChildId]) {
                    const remoteChild = findNode(newChildId, remoteDoc.root);
                    if (remoteChild) {
                        localNode.children.push(JSON.parse(JSON.stringify(remoteChild)));
                    }
                }
            }
        }

        for (const child of (localNode.children || [])) {
            mergeNode(child);
        }
    }

    mergeNode(merged.root);
    merged.version = Math.max(localDoc.version || 1, remoteDoc.version || 1) + 1;
    return merged;
}

export function countNodes(node) {
    let count = 0;
    for (const child of node.children) {
        count += 1 + countNodes(child);
    }
    return count;
}
