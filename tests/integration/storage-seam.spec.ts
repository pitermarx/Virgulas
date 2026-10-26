import { test, expect, type Page } from '../test';

/**
 * Storage-seam end-to-end (docs/storage-interface.md §10): unlock, autosave
 * and the head-token poll flow against a fake remote injected through the
 * window.supabase seam — the contract-level complement to sync-polling-merge.
 *
 * The centerpiece is the sync-01 regression: a remote rotated on another
 * device (foreign salt) locks the stale device and prompts for the new
 * passphrase, and is never silently overwritten by the next local push.
 */
const installMock = async (page: Page, seed?: { salt: string; data: string }) => {
  await page.addInitScript(({ seed }: { seed?: { salt: string; data: string } }) => {
    const state: any = {
      serverRecord: null as any,
      upserts: [] as any[],
      session: { user: null as any }
    };
    (window as any).__mock = state;

    // Accelerate the 60s poll so the pull paths run inside the test.
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const adjusted = timeout === 60_000 ? 60 : timeout;
      return nativeSetInterval(handler, adjusted as number, ...args);
    }) as typeof window.setInterval;

    const builder: any = {
      select: (columns: string) => { builder.__columns = columns || ''; return builder; },
      eq: () => builder,
      single: async () => {
        const columns = builder.__columns || '';
        builder.__columns = '';
        if (!state.serverRecord) return { data: null, error: { code: 'PGRST116' } };
        if (columns === 'updated_at') return { data: { updated_at: state.serverRecord.updated_at }, error: null };
        return { data: state.serverRecord, error: null };
      },
      upsert: async (p: any) => {
        // Keep the whole payload so tests can assert identity binding.
        state.upserts.push({ ...p });
        state.serverRecord = { salt: p.salt, data: p.data, updated_at: p.updated_at };
        return { error: null };
      }
    };

    const client = {
      auth: {
        signInWithPassword: async ({ email }: any) => { state.session.user = { id: 'u1', email }; return { data: { user: state.session.user }, error: null }; },
        signUp: async ({ email }: any) => { state.session.user = { id: 'u1', email }; return { data: { user: state.session.user, session: {} }, error: null }; },
        signOut: async () => { state.session.user = null; return { error: null }; },
        getSession: async () => ({ data: { session: state.session.user ? { user: state.session.user } : null }, error: null }),
        getUser: async () => ({ data: { user: state.session.user }, error: null })
      },
      from: () => builder
    };

    if (seed) {
      state.serverRecord = { ...seed, updated_at: new Date().toISOString() };
      localStorage.setItem('vmd_last_mode', 'remote');
    }
    Object.defineProperty(window, 'supabase', { configurable: true, get: () => ({ createClient: () => client }), set: () => { } });
    localStorage.setItem('backendconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
  }, { seed });
};

const buildEncryptedPayload = async (page: Page, passphrase: string, text = 'Start') => {
  return await page.evaluate(async ({ passphrase, text }: { passphrase: string; text: string }) => {
    const app: any = (await import('/js/app.js' as string)).e2e;
    const salt = btoa(String.fromCharCode(...window.crypto.getRandomValues(new Uint8Array(16))));
    const doc = { modelVersion: 'v1', dataVersion: 1, nodes: [
      { id: 'root', text: '', children: ['n1'], parentId: null, open: true, lastModified: 0 },
      { id: 'n1', text, children: [], parentId: 'root', open: true, lastModified: 0 }
    ] };
    const data = await app.encrypt(JSON.stringify(doc), passphrase, salt);
    return { salt, data };
  }, { passphrase, text });
};

const unlockRemote = async (page: Page, pass: string) => {
  const email = page.getByLabel('Email');
  const enableSecureStorage = page.getByRole('button', { name: /Enable Secure Storage/i });

  await expect(email.or(enableSecureStorage).first()).toBeVisible({ timeout: 15000 });

  if (!(await email.isVisible().catch(() => false))) {
    // The banner opens the storage wizard directly.
    await enableSecureStorage.click();
    await page.getByRole('button', { name: /In the cloud/ }).click();
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
    const app: any = (await import('/js/app.js' as string)).e2e;
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

test.describe('storage seam — remote flows', () => {
  test('unlock renders the remote document; edits push with the cached-session uid', async ({ page }) => {
    await page.goto('/');
    // Seed the server record through an init script so it survives the reload
    const seed = await buildEncryptedPayload(page, 'pass-123456', 'Start');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'remote'); });
    await installMock(page, seed);
    await page.reload();
    await unlockRemote(page, 'pass-123456');

    await expect(page.locator('.node-text-md').first()).toHaveText('Start');

    const before = await page.evaluate(() => (window as any).__mock.upserts.length);
    await page.locator('.node-text-md').first().click();
    await page.locator('.node-content input').first().fill('Seam edit');
    await page.locator('body').click();

    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.upserts.length), { timeout: 10000 })
      .toBeGreaterThan(before);

    const last = await page.evaluate(() => {
      const upserts = (window as any).__mock.upserts;
      return upserts[upserts.length - 1];
    });
    // Identity binding (docs §4.2): the uid is sourced from the locally cached
    // session by the adapter — never supplied by the orchestration, and the
    // salt rides with the record for the encrypted decorator.
    expect(last.user_id).toBe('u1');
    expect(typeof last.salt).toBe('string');
    expect(typeof last.updated_at).toBe('string');
  });

  test('a remote rotated on another device locks and prompts without pushing (sync-01)', async ({ page }) => {
    await page.goto('/');
    const seed = await buildEncryptedPayload(page, 'pass-123456', 'Start');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'remote'); });
    await installMock(page, seed);
    await page.reload();
    await unlockRemote(page, 'pass-123456');

    // Rotate on "another device": the row now carries a foreign salt and a
    // document encrypted under a different passphrase.
    await page.evaluate(async () => {
      const app: any = (await import('/js/app.js' as string)).e2e;
      const foreignSalt = btoa(String.fromCharCode(...window.crypto.getRandomValues(new Uint8Array(16))));
      const data = await app.encrypt('Rotated elsewhere', 'other-pass-123', foreignSalt);
      (window as any).__mock.serverRecord = { salt: foreignSalt, data, updated_at: new Date().toISOString() };
    });

    // The next poll pulls, meets the foreign salt, and locks with a prompt
    // instead of pulling-then-pushing over the rotation.
    await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/changed on another device/i)).toBeVisible();

    // ...and no push followed the failed pull (docs §4.4: never followed by a push).
    const count = await page.evaluate(() => (window as any).__mock.upserts.length);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__mock.upserts.length)).toBe(count);
  });
});
