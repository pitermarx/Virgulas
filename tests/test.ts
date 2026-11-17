import { test as base, expect, type Page } from '@playwright/test';

const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const configJson = env.PLAYWRIGHT_SUPABASE_CONFIG;

// The local Playwright build (`dev:test`) scales the PBKDF2 work factor down via
// `__TEST_KDF_SCALE__`; an external/production build derives at the nominal
// iteration count (scale 1). The runner must seed with the same work factor the
// target app uses to decrypt, or every `setupDoc` unlock fails with a wrong key.
// `BASE_URL` is set only when the suite targets an external build.
const SEED_KDF_SCALE_OVERRIDE = env.BASE_URL ? 1 : undefined;

export const test = base.extend({
    page: async ({ page }, use) => {
        await page.route('https://um.vps.pitermarx.com/**', route => route.abort());

        if (configJson) {
            // The legacy `supabaseconfig` key: the `backendconfig` read-through
            // picks it up unless a test pins an explicit backend config.
            await page.addInitScript((value: string) => {
                localStorage.setItem('supabaseconfig', value);
            }, configJson);
        }

        await use(page);
    }
});

export { expect };
export type { Page, Locator } from '@playwright/test';

/**
 * Navigates the storage wizard (choose-mode sheet) to the given mode's
 * credentials step. Assumes the lock screen is visible; opens the wizard via
 * the step's "Change mode" button when the sheet is on the unlock step.
 */
export const pickStorageMode = async (page: Page, mode: 'local' | 'remote' | 'filesystem'): Promise<void> => {
    const changeMode = page.getByRole('button', { name: /Change mode/i });
    const modeOption = mode === 'local'
        ? page.getByRole('button', { name: /On this device/ })
        : page.getByRole('button', { name: /In the cloud/ });

    // The lock screen can re-render while the app is still booting, which
    // clears the wizard state and can swallow a click on "Change mode" — the
    // same race submitUnlock guards against. Retry opening the sheet until the
    // requested option is genuinely on screen.
    await expect(async () => {
        if (await modeOption.isVisible().catch(() => false)) return;
        if (await changeMode.isVisible().catch(() => false)) {
            await changeMode.click();
        }
        await expect(modeOption).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20000 });

    if (mode === 'local') {
        await modeOption.click();
        await page.getByRole('button', { name: /Encrypted storage/ }).click();
        return;
    }
    // The cloud path is a single step: it goes straight to the credentials
    // form (the server resolves itself — same-origin TrailBase or the hosted
    // fallback).
    await modeOption.click();
};

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
        const { encrypt } = (await import(cryptoModulePath)).e2e;
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

/**
 * Fill the lock screen passphrase and submit, then wait for the app to render.
 *
 * Unlock is a key derivation + decrypt, and the lock sheet also re-renders while
 * the boot probes settle, so a submit can be swallowed and the crypto can take
 * seconds on a contended CI runner. Retry the submit until the app renders, with
 * an explicit budget rather than the suite default: two WebKit integration tests
 * needed a retry on 2026-11-14 for exactly this.
 */
export async function unlockApp(
    page: import('@playwright/test').Page,
    passphrase = 'password'
) {
    const rendered = page.locator('body[data-main-view="rendered"]');
    await expect(async () => {
        // A submit that did land still counts when the render was slow.
        if (await rendered.count() > 0) return;
        await submitUnlock(page, passphrase);
        await expect(rendered, 'the app renders after the unlock').toHaveCount(1, { timeout: 20_000 });
    }).toPass({ timeout: 60_000 });
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
    const global = globalThis as { window?: unknown };
    const { encrypt, DEFAULT_ITERATIONS, TEST_KDF_SCALE } = await import('../source/js/crypto2');
    const hadWindow = global.window !== undefined;
    if (!hadWindow) global.window = globalThis;
    try {
        // Pass the work factor explicitly so the runner derives the same key the
        // bundled app will use to decrypt. Nothing in the app reads a runtime
        // scale, so this cannot downgrade the app's own KDF.
        const scale = SEED_KDF_SCALE_OVERRIDE ?? TEST_KDF_SCALE;
        return await encrypt(text, passphrase, salt, DEFAULT_ITERATIONS, scale);
    } finally {
        if (!hadWindow) delete global.window;
    }
}

/**
 * Read a node's parent from the rendered DOM. The parent is the closest
 * ``node`` wrapper that encloses the node's own wrapper, so this follows what
 * actually rendered rather than reading model internals through the e2e seam.
 */
export async function parentViaDom(
    page: import('@playwright/test').Page,
    id: string
): Promise<string | null> {
    return page.evaluate((nodeId) => {
        const content = document.querySelector(`[data-node-id="${nodeId}"]`);
        const parentContent = content?.closest('.node')?.parentElement?.closest('.node')?.querySelector(':scope > .node-content');
        return parentContent?.getAttribute('data-node-id') ?? null;
    }, id);
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

// ── Remote-mode helpers ──────────────────────────────────────────────────────

/** An encrypted row as the backend stores it: `<salt>` + `<envelope>`. */
export interface MockRecord {
    salt: string;
    data: string;
    updated_at?: string;
}

/**
 * Encrypts a document in the runner — no page load, no app bundle, no reload.
 * Accepts the nested shape used by `setupDoc` or a flat `OutlineDoc`.
 */
export async function encryptMockDoc(
    doc: NestedNode | { nodes: unknown[] },
    passphrase = 'password'
): Promise<MockRecord> {
    const flat = 'nodes' in doc ? doc : nestedToFlat(doc as NestedNode);
    const salt = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64');
    return { salt, data: await encryptForSeed(JSON.stringify(flat), passphrase, salt) };
}

export interface MockSupabaseOptions {
    userEmail?: string | null;
    userId?: string;
    /** The record the device downloads (and unlocks) with. */
    downloadData?: MockRecord | null;
    /** Sign-in / sign-up rejection message. */
    authErrorMessage?: string | null;
    /** Sign-up succeeds but returns no session, like a confirmation-required project. */
    confirmRequired?: boolean;
    /** Fail every upsert (runtime-mutable through `__mockSupabase.failUpserts`). */
    alwaysFailUpsert?: boolean;
    /** Delay only the first upsert, to observe the syncing state. */
    firstUpsertDelayMs?: number;
    /** Every head() probe reports a fresh timestamp, so the poll always pulls. */
    headAdvances?: boolean;
    /** Shrink the 60 s poll interval to 60 ms. */
    speedUpPolling?: boolean;
    rememberedMode?: 'local' | 'remote' | null;
    /** Clear localStorage once before the app boots. */
    resetStorage?: boolean;
    /** Accelerate the retry backoff. */
    retryBaseMs?: number;
}

/**
 * Installs the mocked Supabase client behind the `__TEST_HOOKS__` seam, with a
 * one-shot storage seed. Exposes live state at `window.__mockSupabase`:
 * `{ serverRecord, upsertCallCount, upserts, headCalls, readCalls,
 *    updateCalls, deleteCalls }`.
 */
export async function installMockSupabase(
    page: import('@playwright/test').Page,
    options: MockSupabaseOptions = {}
) {
    await page.addInitScript((options: MockSupabaseOptions) => {
        const withStamp = (record: MockRecord, stamp: string) => ({
            salt: record.salt,
            data: record.data,
            updated_at: record.updated_at ?? stamp
        });
        const now = new Date().toISOString();
        const downloaded = options.downloadData ? withStamp(options.downloadData, now) : null;
        const state: any = {
            serverRecord: downloaded,
            upsertCallCount: 0,
            upserts: [] as unknown[],
            headCalls: 0,
            readCalls: 0,
            updateCalls: [] as Record<string, unknown>[],
            deleteCalls: [] as Record<string, unknown>[],
            // Mutable at runtime, so a test can start failing after the unlock
            // save has settled instead of racing it.
            failUpserts: options.alwaysFailUpsert === true,
            // A test sets this at runtime to fail the next N attempts.
            failUpsertTimes: 0
        };
        (window as any).__mockSupabase = state;
        if (options.retryBaseMs != null) (window as any).__retryBaseMs = options.retryBaseMs;
        if (options.speedUpPolling) {
            const nativeSetInterval = window.setInterval.bind(window);
            window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
                nativeSetInterval(handler, timeout === 60_000 ? 60 : timeout, ...args)) as typeof window.setInterval;
        }

        const session: { user: { id: string; email: string } | null } = {
            user: options.userEmail ? { id: options.userId ?? 'user-1', email: options.userEmail } : null
        };

        const builder = () => {
            let columns = '';
            const query: any = {
                select: (next?: string) => { columns = next ?? ''; return query; },
                eq: () => query,
                single: async () => {
                    if (columns === 'updated_at') {
                        state.headCalls++;
                        if (options.headAdvances) {
                            return { data: { updated_at: new Date(Date.now() + state.headCalls).toISOString() }, error: null };
                        }
                        return state.serverRecord
                            ? { data: { updated_at: state.serverRecord.updated_at }, error: null }
                            : { data: null, error: { code: 'PGRST116' } };
                    }
                    state.readCalls++;
                    return state.serverRecord
                        ? { data: state.serverRecord, error: null }
                        : { data: null, error: { code: 'PGRST116' } };
                },
                upsert: (payload: MockRecord) => ({
                    select: () => ({
                        single: async () => {
                            state.upsertCallCount++;
                            state.upserts.push({ ...payload });
                            if (options.firstUpsertDelayMs && state.upsertCallCount === 1) {
                                await new Promise<void>(resolve => setTimeout(resolve, options.firstUpsertDelayMs));
                            }
                            if (state.failUpserts || state.failUpsertTimes > 0) {
                                if (state.failUpsertTimes > 0) state.failUpsertTimes--;
                                return { data: null, error: { message: 'mock network error', code: '503' } };
                            }
                            state.serverRecord = {
                                salt: payload.salt,
                                data: payload.data,
                                updated_at: payload.updated_at ?? new Date().toISOString()
                            };
                            return { data: { updated_at: state.serverRecord.updated_at }, error: null };
                        }
                    })
                }),
                delete: () => ({
                    eq: async (column: string, value: string) => {
                        state.deleteCalls.push({ [column]: value });
                        state.serverRecord = null;
                        return { data: null, error: null };
                    }
                })
            };
            return query;
        };

        const auth = {
            signInWithPassword: async ({ email }: { email: string }) => {
                if (options.authErrorMessage) return { data: { user: null }, error: { message: options.authErrorMessage } };
                session.user = { id: options.userId ?? 'user-1', email };
                return { data: { user: session.user }, error: null };
            },
            signUp: async ({ email }: { email: string }) => {
                if (options.authErrorMessage) return { data: { user: null }, error: { message: options.authErrorMessage } };
                if (options.confirmRequired) {
                    session.user = null;
                    return { data: { user: { id: options.userId ?? 'user-1', email }, session: null }, error: null };
                }
                session.user = { id: options.userId ?? 'user-1', email };
                return { data: { user: session.user, session: { access_token: 't' } }, error: null };
            },
            signOut: async () => { session.user = null; return { error: null }; },
            getSession: async () => ({ data: { session: session.user ? { user: session.user } : null }, error: null }),
            getUser: async () => ({ data: { user: session.user }, error: null }),
            updateUser: async (payload: Record<string, unknown>) => {
                state.updateCalls.push(payload);
                return { data: { user: session.user }, error: null };
            },
            resetPasswordForEmail: async () => ({ error: null })
        };

        Object.defineProperty(window, 'supabase', {
            configurable: true,
            get: () => ({ createClient: () => ({ auth, from: builder }) }),
            set: () => { }
        });

        const seedKey = 'vmd-mock-supabase-seeded';
        if (!sessionStorage.getItem(seedKey) && options.resetStorage) {
            sessionStorage.setItem(seedKey, '1');
            localStorage.clear();
        }
        if (options.rememberedMode) localStorage.setItem('vmd_last_mode', options.rememberedMode);
        localStorage.setItem('backendconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
    }, options);
}

/** Walk the storage wizard from wherever it is to the remote credentials form. */
export async function openStorageWizard(page: import('@playwright/test').Page) {
    const group = page.locator('.wizard-options');
    if (await group.isVisible().catch(() => false)) return;
    const changeMode = page.getByRole('button', { name: /Change mode/i });
    await expect(changeMode).toBeVisible({ timeout: 10000 });
    await changeMode.click();
    await expect(group).toBeVisible({ timeout: 10000 });
}

/**
 * Unlock into Remote mode through the UI, from whichever step the lock screen
 * is on: the memory-mode banner, the account credentials step, or the
 * passphrase step of a still-valid session. Waits for the app to render.
 */
export async function unlockRemote(
    page: import('@playwright/test').Page,
    options: { email?: string; password?: string; passphrase?: string } = {}
) {
    const email = page.getByLabel('Email');
    const enable = page.getByRole('button', { name: /Enable Secure Storage/i });
    const passphrase = page.locator('#auth-passphrase');
    await expect(email.or(passphrase).or(enable).first()).toBeVisible({ timeout: 15000 });

    if (await enable.isVisible().catch(() => false)) {
        await enable.click();
        await page.getByRole('button', { name: /In the cloud/ }).click();
    }
    if (await email.isVisible().catch(() => false)) {
        await email.fill(options.email ?? 'a@b.com');
        await page.getByLabel('Account password').fill(options.password ?? 'pw123456');
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    await page.getByLabel('Encryption passphrase').fill(options.passphrase ?? 'password');
    const rendered = page.locator('body[data-main-view="rendered"]');
    await expect(async () => {
        // A submit that already landed counts even when the render was slow.
        if (await rendered.count() > 0) return;
        const error = page.locator('#auth-unlock-error');
        if (await error.isVisible().catch(() => false)) {
            throw new Error(`remote unlock failed: ${(await error.textContent())?.trim()}`);
        }
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(rendered, 'the app renders after the remote unlock').toHaveCount(1, { timeout: 20_000 });
    }).toPass({ timeout: 60_000 });
}

/** Focus the first visible node and type into its editor. */
export async function editFirstNodeText(page: import('@playwright/test').Page, text: string) {
    const input = page.locator('.node-content input').first();
    if (await input.count() === 0) {
        await page.locator('.node-text-md').first().click();
    }
    await page.locator('.node-content input').first().fill(text);
}

/** Update the first root child through the model (no focus/editor involved). */
export async function setFirstNodeTextViaModel(page: import('@playwright/test').Page, text: string) {
    await page.evaluate(async ({ text }: { text: string }) => {
        const outline = (await import('/js/app.js' as string)).e2e.outline as any;
        const rootChildren: string[] = outline.get('root')?.children?.peek?.() || [];
        if (rootChildren.length > 0) outline.updateNode(rootChildren[0], { text });
    }, { text });
}

/** Decrypt the mocked server row and return the first node's text. */
export async function remoteFirstNodeText(page: import('@playwright/test').Page, passphrase: string) {
    return page.evaluate(async ({ passphrase }: { passphrase: string }) => {
        const { decrypt } = (await import('/js/app.js' as string)).e2e;
        const record = (window as any).__mockSupabase?.serverRecord;
        if (!record?.data || !record?.salt) return null;
        const doc = JSON.parse(await decrypt(record.data, passphrase, record.salt));
        const root = doc.nodes.find((node: any) => node.id === 'root');
        const firstChildId = root?.children?.[0];
        return doc.nodes.find((node: any) => node.id === firstChildId)?.text || null;
    }, { passphrase });
}

