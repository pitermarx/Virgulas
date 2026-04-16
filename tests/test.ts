import { test as base, expect } from '@playwright/test';

const configJson = (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.PLAYWRIGHT_SUPABASE_CONFIG
);

export const test = base.extend({
    page: async ({ page }, use) => {
        if (configJson) {
            await page.addInitScript((value: string) => {
                localStorage.setItem('supabaseconfig', value);
            }, configJson);
        }

        await use(page);
    }
});

export { expect };
export type { Page, Locator } from '@playwright/test';

type NestedNode = {
    id: string,
    text?: string,
    description?: string,
    open?: boolean,
    collapsed?: boolean,
    children?: NestedNode[]
}

type FlatNode = {
    id: string,
    parentId?: string,
    children?: string[],
    [key: string]: any
}

/**
 * Convert a nested test document to the flat format expected by
 * outline.deserialize().
 */
function nestedToFlat(nested: any) {
    const nodes: any[] = [];
    function visit(node: any, parentId: string | null) {
        const flat: Record<string, any> = { id: node.id };
        if (parentId) flat.parentId = parentId;
        if (node.text) flat.text = node.text;
        if (node.description) flat.description = node.description;
        if (node.children?.length) flat.children = node.children.map((c: any) => c.id);
        if (node.open === false || node.collapsed === true) flat.open = false;
        nodes.push(flat);
        for (const child of node.children || []) {
            visit(child, node.id);
        }
    }
    visit(nested, null);
    return { modelVersion: 'v1', dataVersion: 0, nodes };
}

export async function seedEncryptedDoc(
    page: import('@playwright/test').Page,
    json: string,
    passphrase = 'password'
) {
    await page.evaluate(async ({ json, passphrase }) => {
        localStorage.clear();
        const cryptoModulePath: string = '/js/crypto2.js';
        const { encrypt } = await import(cryptoModulePath);
        const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
        const salt = btoa(String.fromCharCode(...saltBytes));
        const encrypted = await encrypt(json, passphrase, salt);
        localStorage.setItem('vmd_data_enc', `${salt}|${encrypted}`);
    }, { json, passphrase });
}

export async function unlockApp(
    page: import('@playwright/test').Page,
    passphrase = 'password'
) {
    await page.getByLabel('Passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
}

export async function moveNodeByPath(
    page: import('@playwright/test').Page,
    fromPath: number[],
    toPath: number[]
) {
    await page.evaluate(async ({ fromPath, toPath }) => {
        const outlineModulePath: string = '/js/outline.js';
        const outline = (await import(outlineModulePath)).default;
        const serialized = JSON.parse(outline.serialize()) as { nodes: FlatNode[] };
        const byId = new Map<string, FlatNode>(serialized.nodes.map((n: FlatNode) => [n.id, { ...n }]));
        const childrenByParent = new Map<string, string[]>();

        for (const node of serialized.nodes) {
            if (node.id === 'root') {
                continue;
            }
            const parentId = node.parentId;
            if (!parentId) {
                throw new Error(`Node ${node.id} has no parentId`);
            }
            if (!childrenByParent.has(parentId)) {
                childrenByParent.set(parentId, []);
            }
            childrenByParent.get(parentId)?.push(node.id);
        }

        const getChildren = (parentId: string) => {
            if (!childrenByParent.has(parentId)) {
                childrenByParent.set(parentId, []);
            }
            return childrenByParent.get(parentId) as string[];
        };

        const idFromPath = (path: number[]) => {
            let currentId = 'root';
            for (const index of path) {
                const children = getChildren(currentId);
                const nextId = children[index];
                if (!nextId) {
                    throw new Error(`Invalid path ${JSON.stringify(path)}`);
                }
                currentId = nextId;
            }
            return currentId;
        };

        const fromId = idFromPath(fromPath);
        const toId = idFromPath(toPath);
        if (fromId === toId) {
            return;
        }

        const fromNode = byId.get(fromId);
        const toNode = byId.get(toId);
        if (!fromNode || !toNode) {
            throw new Error('Unable to resolve source or target node');
        }
        if (!fromNode.parentId || !toNode.parentId) {
            throw new Error('Cannot move root node');
        }

        if (fromNode.parentId === toNode.parentId) {
            const siblings = getChildren(fromNode.parentId);
            const sourceIndex = siblings.indexOf(fromId);
            const targetIndex = siblings.indexOf(toId);
            if (sourceIndex === -1 || targetIndex === -1) {
                throw new Error('Source or target node not found in sibling list');
            }
            if (sourceIndex < targetIndex) {
                const moves = targetIndex - sourceIndex - 1;
                for (let i = 0; i < moves; i++) {
                    outline.moveDown(fromId);
                }
            } else if (sourceIndex > targetIndex) {
                const moves = sourceIndex - targetIndex;
                for (let i = 0; i < moves; i++) {
                    outline.moveUp(fromId);
                }
            }
            return;
        }

        const sourceParentChildren = getChildren(fromNode.parentId);
        const sourceIndex = sourceParentChildren.indexOf(fromId);
        if (sourceIndex === -1) {
            throw new Error('Source node not found in parent');
        }
        sourceParentChildren.splice(sourceIndex, 1);

        const targetParentChildren = getChildren(toNode.parentId);
        const targetIndex = targetParentChildren.indexOf(toId);
        if (targetIndex === -1) {
            throw new Error('Target node not found in parent');
        }
        targetParentChildren.splice(targetIndex, 0, fromId);
        fromNode.parentId = toNode.parentId;

        const orderedNodes: FlatNode[] = [];
        const visited = new Set<string>();

        const visit = (id: string) => {
            if (visited.has(id)) {
                return;
            }
            visited.add(id);
            const node = byId.get(id);
            if (!node) {
                throw new Error(`Node ${id} not found while rebuilding order`);
            }
            orderedNodes.push(node);
            for (const childId of getChildren(id)) {
                visit(childId);
            }
        };

        visit('root');
        for (const node of orderedNodes) {
            const children = getChildren(node.id);
            node.children = children.length > 0 ? children : undefined;
        }
        serialized.nodes = orderedNodes;

        outline.deserialize(JSON.stringify(serialized));
    }, { fromPath, toPath });
}

/**
 * Shared test helper: encrypts a nested doc using the app's crypto,
 * stores it in the correct localStorage format, and unlocks via UI.
 */
export async function setupDoc(
    page: import('@playwright/test').Page,
    doc: NestedNode,
    passphrase = 'password'
) {
    const flat = nestedToFlat(doc);
    const json = JSON.stringify(flat);

    await page.goto('/');
    await seedEncryptedDoc(page, json, passphrase);
    await page.reload();
    await unlockApp(page, passphrase);
}
