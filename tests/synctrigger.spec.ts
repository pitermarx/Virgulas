import { test, expect, type Page } from './test';

/**
 * Regression coverage for "editing a node does not trigger a sync".
 *
 * Two compounding causes were fixed:
 *  1. autosave was a pure debounce, so continuous typing postponed the save
 *     indefinitely (and therefore the push);
 *  2. a push deferred while typing was silently dropped instead of retried.
 */
const installMock = async (page: Page) => {
  await page.addInitScript(() => {
    const state: any = { serverRecord: null, upserts: [] as number[] };
    (window as any).__mock = state;
    const session = { user: null as any };
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      single: async () => state.serverRecord
        ? { data: state.serverRecord, error: null }
        : { data: null, error: { code: 'PGRST116' } },
      upsert: async (p: any) => {
        state.upserts.push(Date.now());
        state.serverRecord = { salt: p.salt, data: p.data, updated_at: p.updated_at };
        return { error: null };
      },
    };
    const client = {
      auth: {
        signInWithPassword: async ({ email }: any) => { session.user = { id: 'u1', email }; return { data: { user: session.user }, error: null }; },
        signUp: async ({ email }: any) => { session.user = { id: 'u1', email }; return { data: { user: session.user, session: {} }, error: null }; },
        signOut: async () => { session.user = null; return { error: null }; },
        getUser: async () => ({ data: { user: session.user }, error: null }),
      },
      from: () => builder,
    };
    Object.defineProperty(window, 'supabase', { configurable: true, get: () => ({ createClient: () => client }), set: () => {} });
    localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
  });
};

const unlockRemote = async (page: Page, pass: string) => {
  const email = page.getByLabel('Email');
  const enableSecureStorage = page.getByRole('button', { name: /Enable Secure Storage/i });

  // The lock screen is only rendered once the async auth bootstrap flips the
  // app shell to ready, which can land *after* the reload's load event. Wait for
  // either surface before branching: a bare isVisible() check races this first
  // paint and sends the flow down the memory-mode path that never appears.
  await expect(email.or(enableSecureStorage).first()).toBeVisible({ timeout: 15000 });

  if (!(await email.isVisible().catch(() => false))) {
    await enableSecureStorage.click();
    await page.getByRole('button', { name: /Change mode/i }).click();
    await page.getByRole('button', { name: 'Remote', exact: true }).click();
  }
  await email.fill('a@b.com');
  await page.getByLabel('Account password').fill('pw123456');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Encryption passphrase').fill(pass);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
};

const seedRemoteDoc = async (page: Page, pass: string) => {
  await page.evaluate(async ({ pass }: { pass: string }) => {
    const app: any = await import('/js/app.js' as string);
    app.outline.reset();
    app.outline.addChild('root', { text: 'Start' });
    const salt = btoa(String.fromCharCode(...window.crypto.getRandomValues(new Uint8Array(16))));
    const data = await app.encrypt(app.outline.serialize(), pass, salt);
    localStorage.clear();
    localStorage.setItem('vmd_last_mode', 'remote');
    (window as any).__seed = { salt, data };
  }, { pass });
  await page.evaluate(() => {
    (window as any).__mock.serverRecord = { ...(window as any).__seed, updated_at: new Date().toISOString() };
  });
  await page.reload();
};

test.describe('remote sync is triggered by edits', () => {
  test('editing node text pushes to the server', async ({ page }) => {
    await installMock(page);
    await page.goto('/');
    await seedRemoteDoc(page, 'pass-123456');
    await unlockRemote(page, 'pass-123456');

    const before = await page.evaluate(() => (window as any).__mock.upserts.length);
    await page.locator('.node-text-md').first().click();
    await page.locator('.node-content input').first().fill('Edited text');
    await page.locator('body').click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.upserts.length), { timeout: 10000 })
      .toBeGreaterThan(before);
  });

  test('creating a node pushes to the server', async ({ page }) => {
    await installMock(page);
    await page.goto('/');
    await seedRemoteDoc(page, 'pass-123456');
    await unlockRemote(page, 'pass-123456');

    const before = await page.evaluate(() => (window as any).__mock.upserts.length);
    await page.locator('.node-text-md').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.locator('.node-content input').last().fill('Brand new node');
    await page.locator('body').click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.upserts.length), { timeout: 10000 })
      .toBeGreaterThan(before);
  });

  test('an edit made while typing continuously still reaches the server', async ({ page }) => {
    // Regression: autosave was a pure debounce, so a user who keeps typing never
    // saved or synced; and the deferred push was dropped rather than retried.
    await installMock(page);
    await page.goto('/');
    await seedRemoteDoc(page, 'pass-123456');
    await unlockRemote(page, 'pass-123456');

    const before = await page.evaluate(() => (window as any).__mock.upserts.length);

    // Type continuously for ~8s without pausing long enough for the debounce.
    await page.locator('.node-text-md').first().click();
    const input = page.locator('.node-content input').first();
    for (let i = 0; i < 40; i++) {
      await input.press('End');
      await input.type('z');
      await page.waitForTimeout(200);
    }

    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.upserts.length), { timeout: 10000 })
      .toBeGreaterThan(before);
  });
});
