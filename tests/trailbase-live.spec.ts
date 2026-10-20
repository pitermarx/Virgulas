import { test, expect, type Page } from './test';

// Drives the REAL app served by the REAL local TrailBase — the deployment
// shape the app's server resolution expects (`trail run --public-dir dist`:
// the app and its sync API share an origin, no server URL configured).
//
// Start the stack first:
//   bun run build
//   docker compose -p virgulas-trail -f scripts/trailbase/compose.yml up -d
// Run:
//   bunx playwright test tests/trailbase-live.spec.ts
// The suite skips itself when the stack is not running.

const BASE = 'http://127.0.0.1:8099';
const MAILPIT = 'http://127.0.0.1:8025';

let stackUp = false
try {
    stackUp = (await fetch(`${BASE}/api/auth/v1/status`, { method: 'GET' })).ok
} catch {
    stackUp = false
}

test.skip(!stackUp, 'local TrailBase compose stack (scripts/trailbase/compose.yml) is not running')

/** Boots the app fresh and opens the cloud credentials form. */
async function openCloudCredentials(page: Page) {
    await page.goto(BASE);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(BASE);
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await page.getByRole('button', { name: /Enable Secure Storage/ }).click();
    await page.getByRole('button', { name: /In the cloud/ }).click();
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 15000 });
}

/** Registers and verifies an account via Mailpit, like a real user. */
async function registerAndVerify(page: Page, email: string, password: string) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Account password').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByText(/Sign-up submitted/)).toBeVisible({ timeout: 15000 });

    await page.waitForTimeout(2000);
    const messagesJson = await (await page.request.get(`${MAILPIT}/api/v1/messages`)).json();
    const msg = (messagesJson.messages ?? []).find((m: any) =>
        (m.To ?? []).some((t: any) => String(t.Address) === email));
    expect(msg).toBeTruthy();
    const full = await (await page.request.get(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
    const verifyUrl = (full.Text as string).match(/https?:\/\/\S*verify_email\/confirm\/\S+/)?.[0]!;
    expect(verifyUrl).toBeTruthy();
    const vpage = await page.context().newPage();
    const vres = await vpage.goto(verifyUrl, { waitUntil: 'load' });
    expect(vres?.status()).toBe(200);
    await vpage.close();
    return msg.ID;
}

test('real sign-up against the real local TrailBase', async ({ page }) => {
    await openCloudCredentials(page);

    const email = `live-${Date.now()}@virgulas.com`;
    await registerAndVerify(page, email, 'Passw0rd123');

    // The app stays on the credentials step (email prefilled) — sign in with
    // the same credentials.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Encryption passphrase').fill('live-pass-1');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 15000 });
});

test('forgot password sends a reset email for a real account', async ({ page }) => {
    await openCloudCredentials(page);

    const email = `reset-${Date.now()}@virgulas.com`;
    // The reset email only goes out for a real account (anti-enumeration),
    // so register and verify first.
    await registerAndVerify(page, email, 'Passw0rd123');

    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByText(new RegExp(`Password reset email sent to ${email}`))).toBeVisible({ timeout: 15000 });

    // Mailpit confirms the reset email actually left the server.
    await page.waitForTimeout(2000);
    const messagesJson = await (await page.request.get(`${MAILPIT}/api/v1/messages`)).json();
    const msgs = (messagesJson.messages ?? []).filter((m: any) =>
        (m.To ?? []).some((t: any) => String(t.Address) === email));
    expect(msgs.length).toBeGreaterThanOrEqual(2, 'verification AND reset emails arrived');
    const full = await (await page.request.get(`${MAILPIT}/api/v1/message/${msgs[0].ID}`)).json();
    expect(full.Text as string).toMatch(/password/i);
});

test('forgot password never reveals whether the account exists', async ({ page }) => {
    await openCloudCredentials(page);

    const ghost = `ghost-${Date.now()}@virgulas.com`;
    await page.getByLabel('Email').fill(ghost);
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    // Same message for an unknown account (anti-enumeration).
    await expect(page.getByText(new RegExp(`Password reset email sent to ${ghost}`))).toBeVisible({ timeout: 15000 });
});
