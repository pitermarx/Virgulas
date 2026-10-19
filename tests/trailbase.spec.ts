import { test, expect, type Page } from './test';

/**
 * Custom-backend selection (PR 3): the backend picker on the Remote unlock
 * flow, and a Custom TrailBase backend end-to-end against a route-mocked
 * TrailBase API.
 *
 * The TrailBase instance URL in these tests is http://127.0.0.1:8099 — allowed
 * by the test build's development CSP (localhost sources), intercepted by
 * Playwright routes so no real server is needed.
 */

type TrailRow = { id: number; user: string; data: string; salt: string | null; updated_at: string }

type TrailState = {
    users: Map<string, { id: string; email: string; password: string }>
    row: TrailRow | null
    loginCalls: number
    registerCalls: number
    patchCalls: number
    postCalls: number
    deleteCalls: number
}

const TRAILBASE_URL = 'http://127.0.0.1:8099';

function makeTrailState(): TrailState {
    return { users: new Map(), row: null, loginCalls: 0, registerCalls: 0, patchCalls: 0, postCalls: 0, deleteCalls: 0 };
}

/** Installs the route-mocked TrailBase API. The state lives in the Node scope:
 * Playwright route handlers run here, not in the page. */
const installTrailbaseMock = async (page: Page, state: TrailState) => {
    const fulfill = (route: any, status: number, body?: any) =>
        route.fulfill({ status, contentType: 'application/json', body: body ? JSON.stringify(body) : undefined });

    await page.route('**/api/auth/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = route.request().postData() ? JSON.parse(route.request().postData()!) : {};

        if (path.endsWith('/api/auth/v1/register')) {
            state.registerCalls++;
            if (!body.email || !body.password || body.password !== body.password_repeat) {
                return fulfill(route, 400, { error: 'bad registration' });
            }
            state.users.set(body.email, { id: 'tb-user-1', email: body.email, password: body.password });
            return fulfill(route, 200, {});
        }
        if (path.endsWith('/api/auth/v1/login')) {
            state.loginCalls++;
            const user = state.users.get(body.email_or_username);
            if (!user || user.password !== body.password) return fulfill(route, 401, { error: 'Invalid login credentials' });
            const jwt = 'h.' + btoa(JSON.stringify({ sub: user.id, email: user.email })) + '.s';
            return fulfill(route, 200, { auth_token: jwt, refresh_token: 'ref-' + state.loginCalls, csrf_token: 'c' });
        }
        if (path.endsWith('/api/auth/v1/status')) {
            const auth = route.request().headers()['authorization'] || '';
            if (!auth.startsWith('Bearer ')) return fulfill(route, 401, {});
            return fulfill(route, 200, { user: { id: 'tb-user-1' } });
        }
        if (path.endsWith('/api/auth/v1/delete')) {
            state.deleteCalls++;
            return fulfill(route, 200, {});
        }
        return fulfill(route, 404, {});
    });

    await page.route('**/api/records/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const method = route.request().method();
        const auth = route.request().headers()['authorization'] || '';
        if (!auth.startsWith('Bearer ')) return fulfill(route, 401, { error: 'no auth' });

        if (method === 'GET' && path.endsWith('/outlines')) {
            return fulfill(route, 200, state.row ? { records: [state.row] } : { records: [] });
        }
        if (method === 'POST' && path.endsWith('/outlines')) {
            state.postCalls++;
            const body = route.request().postDataJSON();
            state.row = { id: 1, user: body.user, data: body.data, salt: body.salt, updated_at: body.updated_at };
            return fulfill(route, 200, { ids: [1] });
        }
        if (method === 'PATCH') {
            state.patchCalls++;
            const body = route.request().postDataJSON();
            state.row = { ...(state.row ?? { id: 1, user: 'tb-user-1' }), data: body.data, salt: body.salt, updated_at: body.updated_at };
            return fulfill(route, 200, { record: state.row });
        }
        if (method === 'DELETE') {
            state.deleteCalls++;
            state.row = null;
            return fulfill(route, 200, {});
        }
        return fulfill(route, 404, {});
    });
};

/** Decrypts the mocked row's envelope in the page (the app's e2e crypto). */
const decryptRow = async (page: Page, passphrase: string): Promise<string> => {
    return await page.evaluate(async ({ passphrase, row }: { passphrase: string; row: TrailRow | null }) => {
        const app: any = (await import('/js/app.js' as string)).e2e;
        if (!row?.data || !row?.salt) return '';
        return await app.decrypt(row.data, passphrase, row.salt);
    }, { passphrase, row: JSON.parse(JSON.stringify(state?.row ?? null)) });
};

let state: TrailState;

const expectLockScreen = async (page: Page) => {
    // The boot for a remembered-local/'empty' state lands on the unlock step;
    // reach the Remote credentials form via the wizard (as the other specs do).
    await expect(page.locator('.bottom-sheet')).toBeVisible({ timeout: 15000 });
    const wizard = page.locator('.wizard-options');
    if (await wizard.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /In the cloud/ }).click();
        await page.getByRole('button', { name: /Virgulas server/ }).click();
        return;
    }
    const modeSwitch = page.locator('.auth-mode-switch');
    if (!(await modeSwitch.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: /Change mode/i }).click();
    }
    await page.getByRole('button', { name: /In the cloud/ }).click();
    await page.getByRole('button', { name: /Virgulas server/ }).click();
};

/** Chooses Custom TrailBase in the picker and configures the instance URL. */
const pickTrailbaseBackend = async (page: Page) => {
    await page.getByRole('button', { name: 'Use your own server' }).click();
    await page.getByRole('radio', { name: /Custom TrailBase/ }).check();
    await page.getByLabel('TrailBase URL').fill(TRAILBASE_URL);
    // The choice persists immediately (backendconfig).
    await expect
        .poll(() => page.evaluate(() => localStorage.getItem('backendconfig')), { timeout: 3000 })
        .toContain('trailbase');
};

test.describe('backend picker', () => {
    test('the wizard path: In the cloud → Bring your own → TrailBase → Continue', async ({ page }) => {
        state = makeTrailState();
        await installTrailbaseMock(page, state);
        await page.goto('/');
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await page.reload();

        await expectLockScreen(page);

        // From the credentials form, re-enter the wizard and take the
        // self-hosted path: In the cloud → Bring your own → TrailBase.
        await page.getByRole('button', { name: /Change mode/i }).click();
        await page.getByRole('button', { name: /In the cloud/ }).click();
        await page.getByRole('button', { name: /Bring your own/ }).click();
        await expect(page.getByRole('radio', { name: /Supabase/ })).toBeVisible();
        await page.getByRole('radio', { name: /TrailBase/ }).check();
        await expect(page.getByLabel('TrailBase URL')).toBeVisible();
        await expect(page.getByLabel('Anon key')).not.toBeVisible();

        // Continue without a URL is rejected; with one it lands on the
        // credentials form naming the custom backend.
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(page.getByText(/Enter the server URL/)).toBeVisible();
        await page.getByLabel('TrailBase URL').fill(TRAILBASE_URL);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(page.getByText('Synced via Custom TrailBase')).toBeVisible();
        await expect(page.getByLabel('Email')).toBeVisible();
    });

    test('offers Virgulas server, Custom Supabase and Custom TrailBase with per-backend config', async ({ page }) => {
        const pickerState = makeTrailState();
        await installTrailbaseMock(page, pickerState);
        await page.goto('/');
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await page.reload();

        await expectLockScreen(page);

        // The hosted default keeps the step simple: a one-line summary with an
        // opt-in expander instead of an always-visible 3-way choice.
        await expect(page.getByText('Synced via the free Virgulas server')).toBeVisible();
        await page.getByRole('button', { name: 'Use your own server' }).click();

        const virgulas = page.getByRole('radio', { name: /Virgulas server/ });
        const supabase = page.getByRole('radio', { name: /Custom Supabase/ });
        const trailbase = page.getByRole('radio', { name: /Custom TrailBase/ });
        await expect(virgulas).toBeVisible();
        await expect(supabase).toBeVisible();
        await expect(trailbase).toBeVisible();

        // The hosted default is preselected and needs no configuration.
        await expect(virgulas).toBeChecked();

        // Choosing a custom backend reveals exactly its configuration fields.
        await supabase.check();
        await expect(page.getByLabel('Supabase URL')).toBeVisible();
        await expect(page.getByLabel('Anon key')).toBeVisible();
        await expect(page.getByLabel('TrailBase URL')).not.toBeVisible();

        await trailbase.check();
        await expect(page.getByLabel('TrailBase URL')).toBeVisible();
        await expect(page.getByLabel('Anon key')).not.toBeVisible();
        await expect(page.getByLabel('Supabase URL')).not.toBeVisible();

        // Back to the hosted server, then collapse via the toggle.
        await virgulas.check();
        await page.getByRole('button', { name: 'Hide server options' }).click();
        await expect(page.getByText('Synced via the free Virgulas server')).toBeVisible();
        await expect(page.getByRole('radio', { name: /Custom TrailBase/ })).not.toBeVisible();
    });
});

test.describe('Custom TrailBase end-to-end', () => {
    test('registers, signs in and pushes the document to the TrailBase instance', async ({ page }) => {
        state = makeTrailState();
        await installTrailbaseMock(page, state);
        await page.goto('/');
        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await page.reload();

        await expectLockScreen(page);

        // Register first: TrailBase's register never signs the user in.
        await pickTrailbaseBackend(page);
        await page.getByLabel('Email').fill('owner@virgulas.com');
        await page.getByLabel('Account password').fill('pw-123456');
        await page.getByRole('button', { name: 'Sign up' }).click();
        // The anti-enumeration register reports success; the app parks on the
        // unlock step with the message. Go back to the credentials form and
        // sign in with the same credentials.
        await expect(page.getByText(/Sign-up submitted/)).toBeVisible();
        await page.getByRole('button', { name: 'Back' }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByLabel('Encryption passphrase').fill('trail-pass-1');
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        // Edit: the save creates the user's row (identity binding: the owner
        // field, ACL-verified server-side; the salt rides with the record).
        await page.locator('.node-text-md').first().click();
        await page.locator('.node-content input').first().fill('TrailBase edit');
        await page.locator('body').click();

        // The unlock's first-time write already created the row; the edit's
        // save must PATCH it (upsert semantics).
        await expect.poll(() => state.patchCalls, { timeout: 15000 }).toBe(1);
        expect(state.postCalls).toBe(1);
        expect(state.row?.user).toBe('tb-user-1');   // identity binding: the owner field, ACL-verified
        expect(state.row?.salt).not.toBeNull();      // the salt rides with the record
        expect(state.row?.data.startsWith('v2:600000:')).toBe(true);   // the at-rest envelope

        // The row's data is ciphertext — decrypt it in the page to check the content.
        const firstDecrypt = await decryptRow(page, 'trail-pass-1');
        expect(firstDecrypt).toContain('TrailBase edit');

        // The second save patches the same row (upsert semantics).
        await page.locator('.node-text-md').first().click();
        await page.locator('.node-content input').first().fill('TrailBase edit 2');
        await page.locator('body').click();

        // The second save re-encrypts under the same salt; wait for the
        // decrypted content (the patch may still be debounced).
        await expect.poll(async () => await decryptRow(page, 'trail-pass-1'), { timeout: 15000 }).toContain('TrailBase edit 2');
        expect(state.row?.user).toBe('tb-user-1');
    });

    test('the remembered TrailBase backend boots straight into its unlock flow', async ({ page }) => {
        state = makeTrailState();
        // An existing account on the instance: this flow signs in directly.
        state.users.set('owner@virgulas.com', { id: 'tb-user-1', email: 'owner@virgulas.com', password: 'pw-123456' });
        await installTrailbaseMock(page, state);
        await page.goto('/');
        await page.evaluate(({ url }: { url: string }) => {
            localStorage.clear();
            localStorage.setItem('vmd_last_mode', 'remote');
            localStorage.setItem('backendconfig', JSON.stringify({ backend: 'trailbase', url }));
        }, { url: TRAILBASE_URL });
        await page.reload();

        // The lock screen names the configured backend...
        await expect(page.getByText('Remote — Custom TrailBase')).toBeVisible({ timeout: 15000 });
        // ...and sign-in runs against the TrailBase adapter.
        await page.getByLabel('Email').fill('owner@virgulas.com');
        await page.getByLabel('Account password').fill('pw-123456');
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByLabel('Encryption passphrase').fill('trail-pass-1');
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        expect(state.loginCalls).toBeGreaterThanOrEqual(1);
    });
});
