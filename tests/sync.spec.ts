import { test, expect, type Page } from './test';

/** Installs a mock Supabase client with configurable upsert behaviour. */
const installFailingMockSupabase = async (
    page: Page,
    options: {
        userEmail?: string;
        downloadData?: { salt: string; data: string } | null;
        failUpsertTimes?: number;   // fail the first N upsert calls, then succeed
        alwaysFailUpsert?: boolean; // fail every upsert call regardless
    } = {}
) => {
    await page.addInitScript(
        ({ userEmail, downloadData, failUpsertTimes, alwaysFailUpsert }) => {
            const initialRecord = downloadData
                ? { salt: downloadData.salt, data: downloadData.data, updated_at: new Date().toISOString() }
                : null;

            (window as any).__mockSupabaseState = {
                serverRecord: initialRecord,
                upsertCallCount: 0
            };

            const sessionState = {
                user: userEmail ? { id: 'user-sync', email: userEmail } : null as any
            };

            const queryBuilder = {
                select: () => queryBuilder,
                eq: () => queryBuilder,
                single: async () =>
                    (window as any).__mockSupabaseState.serverRecord
                        ? { data: (window as any).__mockSupabaseState.serverRecord, error: null }
                        : { data: null, error: { code: 'PGRST116' } },
                upsert: async (payload: { salt: string; data: string; updated_at: string }) => {
                    (window as any).__mockSupabaseState.upsertCallCount++;
                    const callNo = (window as any).__mockSupabaseState.upsertCallCount;
                    const shouldFail = alwaysFailUpsert || (failUpsertTimes != null && callNo <= failUpsertTimes);
                    if (shouldFail) {
                        return { error: { message: 'mock network error', code: '503' } };
                    }
                    (window as any).__mockSupabaseState.serverRecord = {
                        salt: payload.salt,
                        data: payload.data,
                        updated_at: payload.updated_at
                    };
                    return { error: null };
                }
            };

            const client = {
                auth: {
                    signInWithPassword: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'user-sync', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signUp: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'user-sync', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signOut: async () => { sessionState.user = null; return { error: null }; },
                    getUser: async () => ({ data: { user: sessionState.user }, error: null })
                },
                from: () => queryBuilder
            };

            Object.defineProperty(window, 'supabase', {
                configurable: true,
                get: () => ({ createClient: () => client }),
                set: () => { }
            });

            localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
        },
        options
    );
};

/** Encrypts a doc and returns { salt, data } using the page's crypto module. */
const buildEncryptedPayload = async (page: Page, passphrase: string) => {
    return await page.evaluate(async ({ passphrase }: { passphrase: string }) => {
        const { encrypt } = await import('/js/crypto2.js');
        const outline = (await import('/js/outline.js')).default;
        outline.reset();
        outline.addChild('root', { text: 'Sync Test Node' });
        const json = outline.serialize();
        const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
        const salt = btoa(String.fromCharCode(...saltBytes));
        const data = await encrypt(json, passphrase, salt);
        return { salt, data };
    }, { passphrase });
};

/** Unlock the app in remote mode via the lock screen UI. */
const unlockRemote = async (page: Page, email: string, accountPass: string, passphrase: string) => {
    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Account password').fill(accountPass);
    await page.getByLabel('Encryption passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
};

/** Trigger an edit on the first visible node. */
const editFirstNode = async (page: Page, text: string) => {
    await page.locator('.node-text-md').first().click();
    const input = page.locator('.node-content input').first();
    await input.fill(text);
};

test.describe('Sync status indicator', () => {
    test('sync-dot shows synced after a successful remote upload', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, { userEmail: 'user@test.com', downloadData: payload });
        // Use a very short retry base delay so the test runs quickly
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Synced Edit');

        // After debounce (1s) + successful upload, dot should settle on 'synced'
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 4000 });
    });

    test('sync-dot shows error when all retries are exhausted', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            alwaysFailUpsert: true
        });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Error Edit');

        // debounce (1s) + 3 retries × base ≈ 30+60+120 ms = well under 1s extra
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 4000 });
    });

    test('sync-dot shows offline when navigator.onLine is false and upload fails', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            alwaysFailUpsert: true
        });
        await page.addInitScript(() => {
            (window as any).__retryBaseMs = 30;
            // Force navigator.onLine to report false
            Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Offline Edit');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: offline', { timeout: 4000 });
    });

    test('sync-dot transitions syncing → synced during upload', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });

        // Add a small delay to upsert so we can catch the 'syncing' state
        await page.addInitScript(({ downloadData }: { downloadData: { salt: string; data: string } }) => {
            (window as any).__retryBaseMs = 30;
            const initialRecord = { ...downloadData, updated_at: new Date().toISOString() };
            (window as any).__mockSupabaseState = { serverRecord: initialRecord, upsertCallCount: 0 };

            const sessionState = { user: { id: 'u', email: 'user@test.com' } as any };
            const queryBuilder = {
                select: () => queryBuilder, eq: () => queryBuilder,
                single: async () => ({ data: (window as any).__mockSupabaseState.serverRecord, error: null }),
                upsert: async (payload: any) => {
                    (window as any).__mockSupabaseState.upsertCallCount++;
                    // Long delay so Playwright can reliably observe the 'syncing' DOM state
                    await new Promise<void>(r => setTimeout(r, 3000));
                    (window as any).__mockSupabaseState.serverRecord = { ...payload, updated_at: payload.updated_at };
                    return { error: null };
                }
            };
            const client = {
                auth: {
                    signInWithPassword: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'u', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signUp: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'u', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signOut: async () => { sessionState.user = null; return { error: null }; },
                    getUser: async () => ({ data: { user: sessionState.user }, error: null })
                },
                from: () => queryBuilder
            };
            Object.defineProperty(window, 'supabase', { configurable: true, get: () => ({ createClient: () => client }), set: () => { } });
            localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
        }, { downloadData: payload });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Transition Edit');

        // Wait for the debounce to fire and upload to start
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: syncing', { timeout: 4000 });
        // Then wait for upload to complete (3 s delay in mock + buffer)
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 6000 });
    });
});

test.describe('Sync retry behaviour', () => {
    test('retries upsert with exponential backoff and succeeds after N failures', async ({ page }) => {
        const FAIL_TIMES = 2; // fail first 2 attempts, succeed on 3rd

        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            failUpsertTimes: FAIL_TIMES
        });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Retry Edit');

        // The sync-dot starts at 'synced' (initial value), so we must NOT check for 'synced'
        // before confirming the upload actually ran. Use expect.poll to wait for all retries.
        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount),
            { timeout: 4000, intervals: [100] }
        ).toBeGreaterThanOrEqual(FAIL_TIMES + 1);

        // After FAIL_TIMES failures + 1 success the dot should settle on 'synced'
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 1000 });

        // upsert was called FAIL_TIMES + 1 (the final successful attempt)
        const callCount = await page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount);
        expect(callCount).toBe(FAIL_TIMES + 1);
    });

    test('abandons upload after max retries and records all attempts', async ({ page }) => {
        const MAX_RETRIES = 3; // must match retryWithBackoff default maxRetries

        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            alwaysFailUpsert: true
        });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Exhaust Retries');

        // Wait for all retries to exhaust: 1000ms debounce + 30+60+120 = 210ms retries
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 4000 });

        // Exactly 1 (initial attempt) + MAX_RETRIES calls were made
        const callCount = await page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount);
        expect(callCount).toBe(MAX_RETRIES + 1);
    });

    test('recovers on next write after coming back online', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });

        // Single addInitScript with a controllable flag — avoids replacing the already-cached
        // persistence.js client mid-test (which would have no effect).
        await page.addInitScript(({ downloadData }: { downloadData: { salt: string; data: string } }) => {
            (window as any).__retryBaseMs = 30;
            (window as any).__shouldUpsertFail = true;

            const state = {
                serverRecord: { ...downloadData, updated_at: new Date().toISOString() },
                upsertCallCount: 0
            };
            (window as any).__mockSupabaseState = state;

            const sessionState = { user: { id: 'u', email: 'user@test.com' } as any };
            const queryBuilder = {
                select: () => queryBuilder, eq: () => queryBuilder,
                single: async () => ({ data: state.serverRecord, error: null }),
                upsert: async (p: any) => {
                    state.upsertCallCount++;
                    if ((window as any).__shouldUpsertFail) {
                        return { error: { message: 'network error', code: '503' } };
                    }
                    state.serverRecord = { ...p, updated_at: p.updated_at };
                    return { error: null };
                }
            };
            const client = {
                auth: {
                    signInWithPassword: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'u', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signUp: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'u', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signOut: async () => { sessionState.user = null; return { error: null }; },
                    getUser: async () => ({ data: { user: sessionState.user }, error: null })
                },
                from: () => queryBuilder
            };
            Object.defineProperty(window, 'supabase', { configurable: true, get: () => ({ createClient: () => client }), set: () => { } });
            localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
        }, { downloadData: payload });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', 'sync-pass');

        // Edit while upsert is failing → error state
        await editFirstNode(page, 'Failing Write');
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 5000 });

        // Fix the flag so next upload succeeds, then make another edit.
        // The node may still be in edit mode (input focused) from the previous
        // editFirstNode call, so drive the change through the outline model
        // directly to avoid any UI focus state issues.
        await page.evaluate(() => { (window as any).__shouldUpsertFail = false; });

        await page.evaluate(async () => {
            const outline = (await import('/js/outline.js')).default as any;
            const rootChildren: string[] = outline.get('root')?.children?.peek?.() || [];
            if (rootChildren.length > 0) {
                const node = outline.get(rootChildren[0]);
                const current: string = node?.value?.text || '';
                outline.updateNode(rootChildren[0], { text: current + ' v2' });
            }
        });

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 4000 });
    });
});
