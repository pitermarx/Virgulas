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
    done?: boolean | null,
    meta?: Record<string, string>,
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
        if (node.meta) {
            const parts: string[] = [node.text || ''];
            for (const [key, value] of Object.entries(node.meta)) {
                parts.push(`${key}:${value}`);
            }
            flat.text = parts.filter(Boolean).join(' ');
        } else if (node.text) {
            flat.text = node.text;
        }
        if (node.description) flat.description = node.description;
        if (node.children?.length) flat.children = node.children.map((c: any) => c.id);
        if (node.open === false || node.collapsed === true) flat.open = false;
        if (node.done !== undefined) flat.done = node.done;
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
        const cryptoModulePath: string = '/js/app.js';
        const { encrypt } = await import(cryptoModulePath);
        const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
        const salt = btoa(String.fromCharCode(...saltBytes));
        const encrypted = await encrypt(json, passphrase, salt);
        localStorage.setItem('vmd_data_enc', `${salt}|${encrypted}`);
        // Mark local as the remembered mode so the app shows the lock screen
        localStorage.setItem('vmd_last_mode', 'local');
    }, { json, passphrase });
}

/**
 * Fill the lock screen passphrase and submit.
 *
 * The lock screen can re-render while the app is still booting, which clears the
 * filled input and re-disables the Unlock button. A plain fill+click therefore
 * races: the click hits a disabled button and the app silently stays locked
 * (this was the cause of flaky unlock failures across the sync/zoom specs).
 * Retry the fill until the button is genuinely enabled before clicking.
 */
export async function submitUnlock(
    page: import('@playwright/test').Page,
    passphrase = 'password'
) {
    const input = page.locator('#auth-passphrase');
    const unlock = page.getByRole('button', { name: 'Unlock' });
    await expect(async () => {
        await input.fill(passphrase);
        await expect(unlock).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await unlock.click();
}

export async function unlockApp(
    page: import('@playwright/test').Page,
    passphrase = 'password'
) {
    await submitUnlock(page, passphrase);
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
}

/**
 * Encrypts a document inside the test runner itself.
 *
 * `setupDoc` needs the ciphertext before the page navigates, so it cannot use the
 * browser's crypto without paying a throwaway page load first. `crypto2.ts`
 * targets the browser but only touches `window.crypto`, so a temporary Node alias
 * lets the runner reuse the exact same envelope code byte-for-byte.
 */
async function encryptForSeed(text: string, passphrase: string, salt: string): Promise<string> {
    const global = globalThis as { window?: unknown; __kdfScale?: number };
    const { encrypt, TEST_KDF_SCALE } = await import('../source/js/crypto2');
    const hadWindow = global.window !== undefined;
    const hadScale = global.__kdfScale;
    if (!hadWindow) global.window = globalThis;
    // Match the work factor the Playwright bundle derived its keys with, or the
    // app cannot decrypt what we seed.
    global.__kdfScale = TEST_KDF_SCALE;
    try {
        return await encrypt(text, passphrase, salt);
    } finally {
        if (!hadWindow) delete global.window;
        if (hadScale === undefined) delete global.__kdfScale; else global.__kdfScale = hadScale;
    }
}

/**
 * Shared test helper: encrypts a document in the runner, seeds it into storage
 * before the app boots, and unlocks via the UI.
 *
 * The seed is applied from an `addInitScript`, so the first (and only) navigation
 * already boots into the document. This replaces the previous goto + in-page
 * encrypt + reload round trip. A one-shot `sessionStorage` guard keeps the seed
 * from firing again on later reloads, so edits a test makes still persist.
 */
export async function setupDoc(
    page: import('@playwright/test').Page,
    doc: NestedNode,
    passphrase = 'password'
) {
    const flat = nestedToFlat(doc);
    const json = JSON.stringify(flat);
    const salt = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64');
    const encrypted = await encryptForSeed(json, passphrase, salt);
    const seedKey = `vmd-seed-${Math.random().toString(36).slice(2)}`;

    await page.addInitScript(({ salt, encrypted, seedKey }) => {
        if (sessionStorage.getItem(seedKey)) return;
        sessionStorage.setItem(seedKey, '1');
        localStorage.clear();
        localStorage.setItem('vmd_data_enc', `${salt}|${encrypted}`);
        localStorage.setItem('vmd_last_mode', 'local');
    }, { salt, encrypted, seedKey });

    await page.goto('/');
    await unlockApp(page, passphrase);
}
