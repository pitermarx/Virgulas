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

const openAdvancedStorageOptions = async (page: Page) => {
    const modeSwitchGroup = page.locator('.auth-mode-switch');
    if (await modeSwitchGroup.isVisible().catch(() => false)) {
        return;
    }
    const changeModeBtn = page.getByRole('button', { name: /Change mode/i });
    await expect(changeModeBtn).toBeVisible({ timeout: 10000 });
    await changeModeBtn.click();
    await expect(modeSwitchGroup).toBeVisible({ timeout: 10000 });
};

/** Unlock the app in remote mode via the lock screen UI. */
const unlockRemote = async (page: Page, email: string, accountPass: string, passphrase: string) => {
    await openAdvancedStorageOptions(page);
    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Account password').fill(accountPass);
    await page.getByLabel('Encryption passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
};

/** Trigger an edit on the first visible node. */
const editFirstNode = async (page: Page, text: string) => {
    const existingInput = page.locator('.node-content input').first();
    if (await existingInput.count() === 0) {
        await page.locator('.node-text-md').first().click();
    }
    await page.locator('.node-content input').first().fill(text);
};

const updateFirstNodeViaModel = async (page: Page, text: string) => {
    await page.evaluate(async ({ text }: { text: string }) => {
        const outline = (await import('/js/outline.js')).default as any;
        const rootChildren: string[] = outline.get('root')?.children?.peek?.() || [];
        if (rootChildren.length > 0) {
            outline.updateNode(rootChildren[0], { text });
        }
    }, { text });
};

const readRemoteFirstNodeText = async (page: Page, passphrase: string) => {
    return await page.evaluate(async ({ passphrase }: { passphrase: string }) => {
        const { decrypt } = await import('/js/crypto2.js');
        const record = (window as any).__mockSupabaseState.serverRecord;
        if (!record?.data || !record?.salt) return null;
        const json = await decrypt(record.data, passphrase, record.salt);
        const doc = JSON.parse(json);
        const root = doc.nodes.find((node: any) => node.id === 'root');
        const firstChildId = root?.children?.[0];
        return doc.nodes.find((node: any) => node.id === firstChildId)?.text || null;
    }, { passphrase });
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

    test('debounces rapid edits into one final remote upload', async ({ page }) => {
        await page.goto('/');
        const passphrase = 'sync-pass';
        const payload = await buildEncryptedPayload(page, passphrase);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, { userEmail: 'user@test.com', downloadData: payload });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        await editFirstNode(page, 'First Draft');
        await page.waitForTimeout(500);
        await updateFirstNodeViaModel(page, 'Final Draft');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 5000 });
        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount),
            { timeout: 5000, intervals: [100] }
        ).toBe(1);

        await expect(await readRemoteFirstNodeText(page, passphrase)).toBe('Final Draft');
    });

    test('a new write supersedes a slow in-flight upload', async ({ page }) => {
        await page.goto('/');
        const passphrase = 'sync-pass';
        const payload = await buildEncryptedPayload(page, passphrase);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await page.addInitScript(({ downloadData }: { downloadData: { salt: string; data: string } }) => {
            (window as any).__retryBaseMs = 30;
            const initialRecord = { ...downloadData, updated_at: new Date().toISOString() };
            (window as any).__mockSupabaseState = { serverRecord: initialRecord, upsertCallCount: 0 };

            const sessionState = { user: { id: 'u', email: 'user@test.com' } as any };
            const queryBuilder = {
                select: () => queryBuilder,
                eq: () => queryBuilder,
                single: async () => ({ data: (window as any).__mockSupabaseState.serverRecord, error: null }),
                upsert: async (payload: any) => {
                    (window as any).__mockSupabaseState.upsertCallCount++;
                    const callNo = (window as any).__mockSupabaseState.upsertCallCount;
                    if (callNo === 1) {
                        await new Promise<void>(r => setTimeout(r, 2500));
                    }
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

            Object.defineProperty(window, 'supabase', {
                configurable: true,
                get: () => ({ createClient: () => client }),
                set: () => { }
            });

            localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
        }, { downloadData: payload });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        await editFirstNode(page, 'First Upload');
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: syncing', { timeout: 4000 });

        await updateFirstNodeViaModel(page, 'Second Upload');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 8000 });
        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount),
            { timeout: 8000, intervals: [100] }
        ).toBe(2);

        await expect(await readRemoteFirstNodeText(page, passphrase)).toBe('Second Upload');
    });

    test('background sync waits until typing stops', async ({ page }) => {
        await page.goto('/');
        const passphrase = 'sync-pass';
        const payload = await buildEncryptedPayload(page, passphrase);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await page.addInitScript(({ downloadData }: { downloadData: { salt: string; data: string } }) => {
            (window as any).__retryBaseMs = 30;
            (window as any).__syncPollIntervalMs = 100;

            const initialRecord = { ...downloadData, updated_at: new Date().toISOString() };
            const state = {
                serverRecord: initialRecord,
                upsertCallCount: 0,
                singleCallCount: 0
            };
            (window as any).__mockSupabaseState = state;

            const sessionState = { user: { id: 'u', email: 'user@test.com' } as any };
            const queryBuilder = {
                select: () => queryBuilder,
                eq: () => queryBuilder,
                single: async () => {
                    state.singleCallCount++;
                    return { data: state.serverRecord, error: null };
                },
                upsert: async (payload: any) => {
                    state.upsertCallCount++;
                    state.serverRecord = { ...payload, updated_at: payload.updated_at };
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

            Object.defineProperty(window, 'supabase', {
                configurable: true,
                get: () => ({ createClient: () => client }),
                set: () => { }
            });

            localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
        }, { downloadData: payload });

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        for (const text of ['Typing 1', 'Typing 2', 'Typing 3', 'Typing 4']) {
            await updateFirstNodeViaModel(page, text);
            await page.waitForTimeout(250);
        }

        const duringTypingUploads = await page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount);
        expect(duringTypingUploads).toBe(0);

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount),
            { timeout: 5000, intervals: [100] }
        ).toBeGreaterThan(0);

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 5000 });
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
        const baselineCalls = await page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount);

        await editFirstNode(page, 'Retry Edit');

        // The sync-dot starts at 'synced' (initial value), so we must NOT check for 'synced'
        // before confirming the upload actually ran. Use expect.poll to wait for all retries.
        await expect.poll(
            () => page.evaluate((baseline) => (window as any).__mockSupabaseState.upsertCallCount - baseline, baselineCalls),
            { timeout: 4000, intervals: [100] }
        ).toBeGreaterThanOrEqual(FAIL_TIMES + 1);

        // After FAIL_TIMES failures + 1 success the dot should settle on 'synced'
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 1000 });

        // upsert was called FAIL_TIMES + 1 (the final successful attempt)
        const callDelta = await page.evaluate((baseline) => (window as any).__mockSupabaseState.upsertCallCount - baseline, baselineCalls);
        expect(callDelta).toBe(FAIL_TIMES + 1);
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
        const baselineCalls = await page.evaluate(() => (window as any).__mockSupabaseState.upsertCallCount);

        await editFirstNode(page, 'Exhaust Retries');

        // Wait for all retries to exhaust: 1000ms debounce + 30+60+120 = 210ms retries
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 4000 });

        // Exactly 1 (initial attempt) + MAX_RETRIES calls were made
        const callDelta = await page.evaluate((baseline) => (window as any).__mockSupabaseState.upsertCallCount - baseline, baselineCalls);
        expect(callDelta).toBe(MAX_RETRIES + 1);
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

        // Fix the flag so next upload succeeds, then make another UI edit.
        await page.evaluate(() => { (window as any).__shouldUpsertFail = false; });

        await editFirstNode(page, 'Recovered Write');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 4000 });
    });
});

// ─── Helpers for conflict / pull-before-push tests ────────────────────────────

/**
 * Build an encrypted payload whose node text is `remoteText`, simulated to
 * have been modified AFTER the local last-sync timestamp by injecting a
 * `lastModified` value in the future relative to `lastSyncedAt`.
 */
const buildConflictPayload = async (
    page: Page,
    passphrase: string,
    remoteNodeText: string,
    remoteLastModified: number
) => {
    return await page.evaluate(
        async ({ passphrase, remoteNodeText, remoteLastModified }: {
            passphrase: string; remoteNodeText: string; remoteLastModified: number;
        }) => {
            const { encrypt } = await import('/js/crypto2.js');
            const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
            const salt = btoa(String.fromCharCode(...saltBytes));
            const doc = {
                modelVersion: 'v1',
                dataVersion: 1,
                nodes: [
                    { id: 'root', text: '', description: '', children: ['n1'], parentId: null, open: true, lastModified: 0 },
                    { id: 'n1', text: remoteNodeText, description: '', children: [], parentId: 'root', open: true, lastModified: remoteLastModified }
                ]
            };
            const data = await encrypt(JSON.stringify(doc), passphrase, salt);
            return { salt, data };
        },
        { passphrase, remoteNodeText, remoteLastModified }
    );
};

const buildChildrenConflictPayload = async (
    page: Page,
    passphrase: string,
    options: {
        parentLastModified: number;
        childId: string;
        childText: string;
        childLastModified: number;
    }
) => {
    return await page.evaluate(
        async ({ passphrase, options }: {
            passphrase: string;
            options: {
                parentLastModified: number;
                childId: string;
                childText: string;
                childLastModified: number;
            };
        }) => {
            const { encrypt } = await import('/js/crypto2.js');
            const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
            const salt = btoa(String.fromCharCode(...saltBytes));
            const doc = {
                modelVersion: 'v1',
                dataVersion: 1,
                nodes: [
                    { id: 'root', text: '', description: '', children: ['n1'], parentId: null, open: true, lastModified: 0 },
                    {
                        id: 'n1',
                        text: 'Parent Node',
                        description: '',
                        children: [options.childId],
                        parentId: 'root',
                        open: true,
                        lastModified: options.parentLastModified
                    },
                    {
                        id: options.childId,
                        text: options.childText,
                        description: '',
                        children: [],
                        parentId: 'n1',
                        open: true,
                        lastModified: options.childLastModified
                    }
                ]
            };
            const data = await encrypt(JSON.stringify(doc), passphrase, salt);
            return { salt, data };
        },
        { passphrase, options }
    );
};

/**
 * Installs a mock that serves `remotePayload` from `read()` but with a
 * `updated_at` value in the future (so `checkRemoteNewer` returns true),
 * while keeping `lastSyncedAt` at 0 in localStorage.
 */
const installMockWithRemoteUpdate = async (
    page: Page,
    payload: { salt: string; data: string },
    remotePayload: { salt: string; data: string }
) => {
    await page.addInitScript(
        ({ payload, remotePayload }: {
            payload: { salt: string; data: string };
            remotePayload: { salt: string; data: string };
        }) => {
            // Start with the local payload (what the user unlocks with)
            const localRecord = { ...payload, updated_at: new Date(Date.now() - 60_000).toISOString() };
            // The remote record is "newer"
            const remoteRecord = { ...remotePayload, updated_at: new Date(Date.now() + 60_000).toISOString() };

            let callCount = 0;
            (window as any).__mockSupabaseState = { serverRecord: remoteRecord, upsertCallCount: 0 };
            (window as any).__retryBaseMs = 30;

            const sessionState = { user: { id: 'user-conflict', email: 'user@test.com' } as any };
            const queryBuilder = {
                select: () => queryBuilder,
                eq: () => queryBuilder,
                single: async () => {
                    callCount++;
                    // First call is from unlockRemote (downloads local doc to decrypt)
                    // Subsequent calls are from checkRemoteNewer / pullAndMerge
                    const record = callCount === 1 ? localRecord : remoteRecord;
                    return { data: record, error: null };
                },
                upsert: async (p: any) => {
                    (window as any).__mockSupabaseState.upsertCallCount++;
                    (window as any).__mockSupabaseState.serverRecord = { ...p, updated_at: p.updated_at };
                    return { error: null };
                }
            };
            const client = {
                auth: {
                    signInWithPassword: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'user-conflict', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signUp: async ({ email }: { email: string }) => {
                        sessionState.user = { id: 'user-conflict', email };
                        return { data: { user: sessionState.user }, error: null };
                    },
                    signOut: async () => { sessionState.user = null; return { error: null }; },
                    getUser: async () => ({ data: { user: sessionState.user }, error: null })
                },
                from: () => queryBuilder
            };
            Object.defineProperty(window, 'supabase', {
                configurable: true, get: () => ({ createClient: () => client }), set: () => { }
            });
            localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://mock', key: 'anon' }));
            // Keep lastSyncedAt at 0 so remote will appear newer
            localStorage.removeItem('vmd_sync_ts');
        },
        { payload, remotePayload }
    );
};

// ─── Pull-before-push ─────────────────────────────────────────────────────────

test.describe('Pull-before-push', () => {
    test('auto-merges non-conflicting remote update before pushing', async ({ page }) => {
        await page.goto('/');

        // Local doc: n1 text = 'Local Node'
        const passphrase = 'merge-pass';
        const localPayload = await buildConflictPayload(page, passphrase, 'Local Node', 0);

        // Remote doc: n1 text = 'Remote Node' (different node — different id so no conflict)
        // Actually let's make n1 same id but only remote modified (localLastModified=0 < lastSyncedAt=0? No)
        // For auto-merge: use different node ids so they merge cleanly
        const remotePayload = await page.evaluate(
            async ({ passphrase }: { passphrase: string }) => {
                const { encrypt } = await import('/js/crypto2.js');
                const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
                const salt = btoa(String.fromCharCode(...saltBytes));
                const doc = {
                    modelVersion: 'v1',
                    dataVersion: 1,
                    nodes: [
                        { id: 'root', text: '', description: '', children: ['n1', 'n2'], parentId: null, open: true, lastModified: 0 },
                        { id: 'n1', text: 'Local Node', description: '', children: [], parentId: 'root', open: true, lastModified: 0 },
                        { id: 'n2', text: 'Remote Only Node', description: '', children: [], parentId: 'root', open: true, lastModified: Date.now() + 3_600_000 }
                    ]
                };
                const data = await encrypt(JSON.stringify(doc), passphrase, salt);
                return { salt, data };
            },
            { passphrase }
        );

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installMockWithRemoteUpdate(page, localPayload, remotePayload);

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        // Zoom into n1 and edit it. Sync merge-apply should not reset zoom to root.
        await page.evaluate(async () => {
            const outline = (await import('/js/outline.js')).default as any;
            outline.zoomIn('n1');
            outline.updateNode('n1', { text: 'Local Edit' });
        });

        // After merge: both n1 (local edit) and n2 (remote-only) should be present; no modal
        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 5000 });
        await expect.poll(
            () => page.evaluate(async () => {
                const outline = (await import('/js/outline.js')).default as any;
                return outline.zoomId.value;
            }),
            { timeout: 2000, intervals: [100] }
        ).toBe('n1');
    });

    test('conflict modal appears when both sides changed the same node text', async ({ page }) => {
        await page.goto('/');

        const passphrase = 'conflict-pass';
        const T_REMOTE = Date.now() + 3_600_000;  // remote modified in far future (always > lastSyncedAt)

        // Local payload: n1 has placeholder text and lastModified=0 (not yet "modified after sync")
        const localPayload = await buildConflictPayload(page, passphrase, 'placeholder', 0);
        // Remote doc: n1 has different text, modified after sync
        const remotePayload = await buildConflictPayload(page, passphrase, 'Remote Version', T_REMOTE);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installMockWithRemoteUpdate(page, localPayload, remotePayload);

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        // Edit the local node via UI — this sets n1.lastModified = Date.now() > lastSyncedAt AND triggers sync
        await editFirstNode(page, 'Local Version');

        // Conflict modal should appear (local and remote both changed n1 after last sync)
        await expect(page.locator('.conflict-overlay')).toBeVisible({ timeout: 6000 });
    });
});

// ─── Conflict resolution modal ────────────────────────────────────────────────

test.describe('Conflict resolution modal', () => {
    async function setupConflict(page: Page, localText: string, remoteText: string) {
        await page.goto('/');
        const passphrase = 'modal-pass';
        const T_REMOTE = Date.now() + 3_600_000;  // remote modified in far future (always > lastSyncedAt)

        // Local payload: n1 has placeholder text and lastModified=0 (not yet "modified after sync")
        const localPayload = await buildConflictPayload(page, passphrase, 'placeholder', 0);
        const remotePayload = await buildConflictPayload(page, passphrase, remoteText, T_REMOTE);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installMockWithRemoteUpdate(page, localPayload, remotePayload);
        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        // Edit the local node via UI — sets n1.lastModified = Date.now() > lastSyncedAt AND triggers sync
        await editFirstNode(page, localText);

        // Wait for modal
        await expect(page.locator('.conflict-overlay')).toBeVisible({ timeout: 6000 });
        return passphrase;
    }

    test('modal shows field name and local / remote values', async ({ page }) => {
        await setupConflict(page, 'My local text', 'My remote text');

        // Should show "Text" field label
        await expect(page.locator('.conflict-field-label')).toHaveText(/text/i);

        // Should show local value in a readonly textarea
        await expect(page.locator('.conflict-value-textarea').first()).toContainText('My local text');

        // Should show remote value
        await expect(page.locator('.conflict-value-textarea').last()).toContainText('My remote text');
    });

    test('"Apply" is disabled until all conflicts are resolved', async ({ page }) => {
        await setupConflict(page, 'A', 'B');

        const applyBtn = page.getByRole('button', { name: 'Apply' });
        await expect(applyBtn).toBeDisabled();

        // Choose local for the conflict
        await page.locator('.conflict-keep-btn').first().click();
        await expect(applyBtn).toBeEnabled();
    });

    test('"Keep local" resolves to local value and Apply closes modal', async ({ page }) => {
        await setupConflict(page, 'Local Wins', 'Remote Loses');

        await page.locator('.conflict-keep-btn').first().click();  // Keep local
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
        // The local text should be in the outline
        await expect(page.locator('.node-text-md').first()).toContainText('Local Wins');
    });

    test('"Keep remote" resolves to remote value and Apply closes modal', async ({ page }) => {
        await setupConflict(page, 'Local Loses', 'Remote Wins');

        // "Keep remote" is the second .conflict-keep-btn in each conflict-side
        await page.locator('.conflict-keep-btn').nth(1).click();
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
        await expect(page.locator('.node-text-md').first()).toContainText('Remote Wins');
    });

    test('"Use all local" resolves all conflicts to local and enables Apply', async ({ page }) => {
        await setupConflict(page, 'AllLocal', 'AllRemote');

        await page.getByRole('button', { name: 'Use all local' }).click();
        const applyBtn = page.getByRole('button', { name: 'Apply' });
        await expect(applyBtn).toBeEnabled();
        await applyBtn.click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
    });

    test('"Use all remote" resolves all conflicts to remote', async ({ page }) => {
        await setupConflict(page, 'Discard', 'Keep This');

        await page.getByRole('button', { name: 'Use all remote' }).click();
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
        await expect(page.locator('.node-text-md').first()).toContainText('Keep This');
    });

    test('modal blocks interaction: sync-dot stays synced after apply', async ({ page }) => {
        await setupConflict(page, 'Block A', 'Block B');

        // While modal is open, sync-dot should not be 'error'
        await expect(page.locator('.sync-dot')).not.toHaveAttribute('title', 'Sync: error');

        // Resolve and apply
        await page.locator('.conflict-keep-btn').first().click();
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 4000 });
    });

    test('children conflict can be resolved by keeping remote values', async ({ page }) => {
        await page.goto('/');

        const passphrase = 'children-conflict-pass';
        const localPayload = await buildChildrenConflictPayload(page, passphrase, {
            parentLastModified: 0,
            childId: 'local-seed-child',
            childText: 'Local Seed Child',
            childLastModified: 0
        });
        const remotePayload = await buildChildrenConflictPayload(page, passphrase, {
            parentLastModified: Date.now() + 3_600_000,
            childId: 'remote-child',
            childText: 'Remote Child',
            childLastModified: Date.now() + 3_600_000
        });

        await page.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('vmd_last_mode', 'local');
        });
        await installMockWithRemoteUpdate(page, localPayload, remotePayload);

        await page.reload();
        await unlockRemote(page, 'user@test.com', 'pass', passphrase);

        // Add a local child to change `children` on the same parent before sync.
        await page.locator('[data-node-id="n1"] .node-text-md').click();
        await page.locator('[data-node-id="n1"] input').press('Enter');

        await expect(page.locator('.conflict-overlay')).toBeVisible({ timeout: 6000 });
        await expect(page.locator('.conflict-field-label')).toHaveText(/children/i);

        await page.locator('.conflict-keep-btn').nth(1).click(); // Keep remote
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 4000 });
        await expect(page.getByText('Remote Child', { exact: true })).toBeVisible();
        await expect(page.getByText('Local Seed Child', { exact: true })).toHaveCount(0);
    });
});
