import { test, expect, type Page } from '../test';

/**
 * The sync server is TrailBase on the origin serving the app (`trail run
 * --public-dir dist`, docs: server resolution) — there is no backend picker
 * and no URL to configure. These tests route-mock the same-origin
 * `/api/...` endpoints (the app is served by the static dev server; the
 * same-origin probe finds the mocked TrailBase), and drive the wizard and a
 * full register/sign-in/push flow against it.
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
            // Unauthenticated: the same-origin probe's marker — a 200 JSON body
            // carrying an `auth_token` key says "TrailBase lives here".
            const auth = route.request().headers()['authorization'] || '';
            if (!auth.startsWith('Bearer ')) return fulfill(route, 200, { auth_token: null, refresh_token: null, csrf_token: null });
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

/** A fresh first-run: no remembered mode, no legacy Supabase config — so the
 * same-origin probe decides the backend. Seeds local mode so the boot lands
 * on the lock screen (memory mode would bypass it). */
const freshVisit = async (page: Page) => {
    await page.goto('/');
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('vmd_last_mode', 'local');
    });
    await page.reload();
};

const expectLockScreen = async (page: Page) => {
    // The boot for a remembered-local/'empty' state lands on the unlock step;
    // reach the Remote credentials form via the wizard (as the other specs do).
    await expect(page.locator('.bottom-sheet')).toBeVisible({ timeout: 15000 });
    const wizard = page.locator('.wizard-options');
    if (!(await wizard.isVisible().catch(() => false))) {
        await page.getByRole('button', { name: /Change mode/i }).click();
    }
    await page.getByRole('button', { name: /In the cloud/ }).click();
};

test.describe('same-origin server resolution', () => {
    test('the wizard\'s cloud step goes straight to the credentials form, naming the server', async ({ page }) => {
        state = makeTrailState();
        await installTrailbaseMock(page, state);
        await freshVisit(page);
        await expectLockScreen(page);

        // The same-origin probe resolved the mocked TrailBase: the form names
        // it, and no backend picker or URL field exists anywhere.
        await expect(page.getByText('Remote — this server')).toBeVisible();
        await expect(page.getByRole('radiogroup')).toHaveCount(0);
        await expect(page.getByLabel(/URL/)).toHaveCount(0);
        await expect(page.getByLabel('Email')).toBeVisible();
    });
});

test.describe('TrailBase end-to-end (same origin)', () => {
    test('registers, signs in and pushes the document to the TrailBase instance', async ({ page }) => {
        state = makeTrailState();
        await installTrailbaseMock(page, state);
        await freshVisit(page);
        await expectLockScreen(page);

        // Register first: TrailBase's register never signs the user in.
        await page.getByLabel('Email').fill('owner@virgulas.com');
        await page.getByLabel('Account password').fill('pw-123456');
        await page.getByRole('button', { name: 'Sign up' }).click();
        // The anti-enumeration register reports success; the app stays on the
        // credentials form (email prefilled) with the explainer. Sign in with
        // the same credentials.
        await expect(page.getByText(/Sign-up submitted/)).toBeVisible();
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

    test('the remembered remote mode boots straight into its unlock flow', async ({ page }) => {
        state = makeTrailState();
        // An existing account on the instance: this flow signs in directly.
        state.users.set('owner@virgulas.com', { id: 'tb-user-1', email: 'owner@virgulas.com', password: 'pw-123456' });
        await installTrailbaseMock(page, state);
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.clear();
            localStorage.removeItem('supabaseconfig');
            localStorage.setItem('vmd_last_mode', 'remote');
        });
        await page.reload();

        // The lock screen names the server...
        await expect(page.getByText('Remote — this server')).toBeVisible({ timeout: 15000 });
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
