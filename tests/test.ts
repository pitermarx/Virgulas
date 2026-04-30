import { test as base, expect } from '@playwright/test';

const configJson = (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.PLAYWRIGHT_SUPABASE_CONFIG
);

export const test = base.extend({
    page: async ({ page }, use) => {
        await page.route('https://um.vps.pitermarx.com/**', route => route.abort());

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
        // Mark local as the remembered mode so the app shows the lock screen
        localStorage.setItem('vmd_last_mode', 'local');
    }, { json, passphrase });
}

export async function unlockApp(
    page: import('@playwright/test').Page,
    passphrase = 'password'
) {
    await page.locator('#auth-passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
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
