import { test, expect, type Page } from './test';

const buildEncryptedPayload = async (page: Page, passphrase: string) => {
    return await page.evaluate(async ({ passphrase }: { passphrase: string }) => {
        const { encrypt } = await import('/js/crypto2.js');
        const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
        const salt = btoa(String.fromCharCode(...saltBytes));
        const doc = {
            modelVersion: 'v1',
            dataVersion: 1,
            nodes: [
                { id: 'root', text: '', description: '', children: ['n1'], parentId: null, open: true, lastModified: 0 },
                { id: 'n1', text: 'Sync Node', description: '', children: [], parentId: 'root', open: true, lastModified: 0 }
            ]
        };
        const data = await encrypt(JSON.stringify(doc), passphrase, salt);
        return { salt, data };
    }, { passphrase });
};

const installPollingMockSupabase = async (
    page: Page,
    payload: { salt: string; data: string }
) => {
    await page.addInitScript(({ payload }) => {
        const state = {
            serverRecord: { ...payload, updated_at: new Date(Date.now() + 60_000).toISOString() },
            getLastUpdateCalls: 0,
            readCalls: 0,
            upsertCalls: 0
        };
        (window as any).__mockSupabaseState = state;

        const nativeSetInterval = window.setInterval.bind(window);
        window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
            const adjustedTimeout = timeout === 60_000 ? 60 : timeout;
            return nativeSetInterval(handler, adjustedTimeout as number, ...args);
        }) as typeof window.setInterval;

        let selectedColumns = '';
        const queryBuilder = {
            select: (columns: string) => {
                selectedColumns = columns || '';
                return queryBuilder;
            },
            eq: () => queryBuilder,
            single: async () => {
                const columns = selectedColumns;
                selectedColumns = '';
                if (columns === 'updated_at') {
                    state.getLastUpdateCalls++;
                    return { data: { updated_at: new Date(Date.now() + 60_000).toISOString() }, error: null };
                }
                state.readCalls++;
                return { data: state.serverRecord, error: null };
            },
            upsert: async (next: { salt?: string; data: string; updated_at: string }) => {
                state.upsertCalls++;
                state.serverRecord = {
                    ...state.serverRecord,
                    ...next,
                    updated_at: next.updated_at || new Date().toISOString()
                };
                return { error: null };
            }
        };

        const sessionState = { user: { id: 'poll-user', email: 'poll@test.com' } as any };
        const client = {
            auth: {
                signInWithPassword: async ({ email }: { email: string }) => {
                    sessionState.user = { id: 'poll-user', email };
                    return { data: { user: sessionState.user }, error: null };
                },
                signUp: async ({ email }: { email: string }) => {
                    sessionState.user = { id: 'poll-user', email };
                    return { data: { user: sessionState.user }, error: null };
                },
                signOut: async () => {
                    sessionState.user = null;
                    return { error: null };
                },
                getUser: async () => ({ data: { user: sessionState.user }, error: null })
            },
            from: () => queryBuilder
        };

        Object.defineProperty(window, 'supabase', {
            configurable: true,
            get: () => ({ createClient: () => client }),
            set: () => { }
        });

        localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://mock', key: 'anon' }));
    }, { payload });
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

const unlockRemote = async (page: Page, email: string, accountPass: string, passphrase: string) => {
    await openAdvancedStorageOptions(page);
    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Account password').fill(accountPass);
    await page.getByLabel('Encryption passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
};

test.describe('Sync polling', () => {
    test('polling starts after remote unlock and stops after lock()', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('vmd_last_mode', 'local');
        });
        await installPollingMockSupabase(page, payload);

        await page.reload();
        await unlockRemote(page, 'poll@test.com', 'pass', 'sync-pass');

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls),
            { timeout: 3000, intervals: [100] }
        ).toBeGreaterThan(0);

        await page.evaluate(async () => {
            const persistence = (await import('/js/persistence.js')).default;
            persistence.lock();
        });
        await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();

        const baseline = await page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls);
        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls - baseline),
            { timeout: 1000, intervals: [200, 200, 200, 200] }
        ).toBeLessThanOrEqual(1);
    });

    test('polling stops after remote sign-out flow', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('vmd_last_mode', 'local');
        });
        await installPollingMockSupabase(page, payload);

        await page.reload();
        await unlockRemote(page, 'poll@test.com', 'pass', 'sync-pass');

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls),
            { timeout: 3000, intervals: [100] }
        ).toBeGreaterThan(0);

        await page.getByRole('button', { name: 'Options' }).click();
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();

        const baseline = await page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls);
        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls - baseline),
            { timeout: 1000, intervals: [200, 200, 200, 200] }
        ).toBeLessThanOrEqual(1);
    });

    test('polling pauses while conflicts are pending and resumes after resolution', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('vmd_last_mode', 'local');
        });
        await installPollingMockSupabase(page, payload);

        await page.reload();
        await unlockRemote(page, 'poll@test.com', 'pass', 'sync-pass');

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls),
            { timeout: 3000, intervals: [100] }
        ).toBeGreaterThan(0);

        const baseline = await page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls);

        await page.evaluate(async () => {
            const { pendingConflicts } = await import('/js/sync.js');
            pendingConflicts.value = [{
                nodeId: 'n1',
                nodeText: 'Sync Node',
                field: 'text',
                localValue: 'Local Value',
                remoteValue: 'Remote Value'
            }];
        });

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls),
            { timeout: 500, intervals: [120, 120, 120, 120] }
        ).toBe(baseline);

        await page.evaluate(async () => {
            const { pendingConflicts } = await import('/js/sync.js');
            pendingConflicts.value = [];
        });

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabaseState.getLastUpdateCalls),
            { timeout: 3000, intervals: [100] }
        ).toBeGreaterThan(baseline);
    });
});

test.describe('Sync merge edge cases', () => {
    test('open field uses last-writer-wins by timestamp and never creates conflicts', async ({ page }) => {
        await page.goto('/');

        const result = await page.evaluate(async () => {
            const { mergeDocuments } = await import('/js/sync.js');
            const localNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: ['n1'], open: true, lastModified: 0 },
                { id: 'n1', parentId: 'root', text: 'Node', description: '', children: [], open: true, lastModified: 110 }
            ];
            const remoteNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: ['n1'], open: true, lastModified: 0 },
                { id: 'n1', parentId: 'root', text: 'Node', description: '', children: [], open: false, lastModified: 150 }
            ];
            const merged = mergeDocuments(localNodes, remoteNodes, 100);
            const mergedNode = merged.merged.find((node: { id: string }) => node.id === 'n1');
            return {
                open: mergedNode?.open,
                conflictFields: merged.conflicts.map((c: { field: string }) => c.field)
            };
        });

        expect(result.open).toBe(false);
        expect(result.conflictFields).not.toContain('open');
    });

    test('deletion wins when node is deleted remotely and unchanged locally', async ({ page }) => {
        await page.goto('/');

        const result = await page.evaluate(async () => {
            const { mergeDocuments } = await import('/js/sync.js');
            const localNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: ['n1'], open: true, lastModified: 0 },
                { id: 'n1', parentId: 'root', text: 'Local Node', description: '', children: [], open: true, lastModified: 90 }
            ];
            const remoteNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: [], open: true, lastModified: 0 }
            ];
            const merged = mergeDocuments(localNodes, remoteNodes, 100);
            return {
                hasNode: merged.merged.some((node: { id: string }) => node.id === 'n1'),
                conflictCount: merged.conflicts.length
            };
        });

        expect(result.hasNode).toBe(false);
        expect(result.conflictCount).toBe(0);
    });

    test('modified side wins over deletion when local node changed after last sync', async ({ page }) => {
        await page.goto('/');

        const result = await page.evaluate(async () => {
            const { mergeDocuments } = await import('/js/sync.js');
            const localNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: ['n1'], open: true, lastModified: 0 },
                { id: 'n1', parentId: 'root', text: 'Locally Modified', description: '', children: [], open: true, lastModified: 150 }
            ];
            const remoteNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: [], open: true, lastModified: 0 }
            ];
            const merged = mergeDocuments(localNodes, remoteNodes, 100);
            return merged.merged.some((node: { id: string }) => node.id === 'n1');
        });

        expect(result).toBe(true);
    });

    test('nodes with missing parents are dropped after merge', async ({ page }) => {
        await page.goto('/');

        const result = await page.evaluate(async () => {
            const { mergeDocuments } = await import('/js/sync.js');
            const localNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: ['orphan'], open: true, lastModified: 0 },
                { id: 'orphan', parentId: 'missing-parent', text: 'Orphan Node', description: '', children: [], open: true, lastModified: 160 }
            ];
            const remoteNodes = [
                { id: 'root', parentId: null, text: '', description: '', children: [], open: true, lastModified: 0 }
            ];
            const merged = mergeDocuments(localNodes, remoteNodes, 100);
            return merged.merged.map((node: { id: string }) => node.id);
        });

        expect(result).toEqual(['root']);
    });
});