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

test('real sign-up against the real local TrailBase', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(BASE);

    // Fresh device boots into memory; 'Enable Secure Storage' must open the
    // WIZARD, not a forced passphrase form.
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await page.getByRole('button', { name: /Enable Secure Storage/ }).click();
    await expect(page.getByText('Where should your notes live?')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /In the cloud/ }).click();
    await expect(page.getByText('Synced via this server')).toBeVisible({ timeout: 15000 });

    const email = `live-${Date.now()}@virgulas.com`;
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Account password').fill('Passw0rd123');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByText(/Sign-up submitted/)).toBeVisible({ timeout: 15000 });

    // Verify via Mailpit from the Node side (the page cannot fetch :8025).
    // Mailpit lists newest first — take THIS run's email.
    await page.waitForTimeout(2000);
    const messagesJson = await (await page.request.get(`${MAILPIT}/api/v1/messages`)).json();
    const msg = (messagesJson.messages ?? []).find((m: any) =>
        (m.To ?? []).some((t: any) => String(t.Address) === email));
    expect(msg).toBeTruthy();
    const full = await (await page.request.get(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
    const verifyUrl = (full.Text as string).match(/https?:\/\/\S*verify_email\/confirm\/\S+/)?.[0]!;
    expect(verifyUrl).toBeTruthy();
    // Verify like a real user: open the link as a navigation in a fresh tab.
    const vpage = await page.context().newPage();
    const vres = await vpage.goto(verifyUrl, { waitUntil: 'load' });
    expect(vres?.status()).toBe(200);
    await vpage.close();

    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Account password').fill('Passw0rd123');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Encryption passphrase').fill('live-pass-1');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 15000 });
});
