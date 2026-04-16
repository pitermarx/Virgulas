import { test, expect, type Page } from './test';

type OutlineNode = {
    id: string;
    text: string;
    description?: string;
    collapsed?: boolean;
    updated_at?: string;
    children: OutlineNode[];
};

type OutlineDoc = {
    id: 'root';
    text: string;
    updated_at: string;
    children: OutlineNode[];
};

const setupSyncHarness = async (page: Page, options: {
    baseDoc: OutlineDoc;
    localDoc: OutlineDoc;
    serverDoc: OutlineDoc;
}) => {
    await page.evaluate(async ({ baseDoc, localDoc, serverDoc }) => {
        localStorage.clear();

        const passphrase = 'merge-passphrase';
        const { encrypt } = await import('/js/crypto2.js');
        const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
        const salt = btoa(String.fromCharCode(...saltBytes));

        const encryptedLocal = await encrypt(JSON.stringify(localDoc), passphrase, salt);
        const encryptedBase = await encrypt(JSON.stringify(baseDoc), passphrase, salt);

        localStorage.setItem('vmd_data_enc', `${salt}|${encryptedLocal}`);
        localStorage.setItem('vmd_sync_base_enc', `${salt}|${encryptedBase}`);

        // Store test state in simple window variables (no signals needed)
        (window as any).__testState = { key: passphrase, doc: localDoc };

        const encryptedServer = await encrypt(JSON.stringify(serverDoc), passphrase, salt);

        (window as any).__mockSupabaseState = {
            serverRecord: {
                salt,
                data: encryptedServer,
                updated_at: serverDoc.updated_at
            },
            lastUpsert: null
        };

        // Each from() call returns a fresh builder so concurrent queries don't clash.
        const makeQueryBuilder = (selectedFields: string = '') => {
            let fields = selectedFields;
            const qb: any = {
                select: (f: string) => { fields = f; return qb; },
                eq: () => qb,
                single: async () => {
                    const record = (window as any).__mockSupabaseState.serverRecord;
                    if (!record) return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
                    // Return only the requested fields when doing a lightweight probe.
                    if (fields === 'updated_at') return { data: { updated_at: record.updated_at }, error: null };
                    return { data: record, error: null };
                },
                upsert: async (payload: { salt: string; data: string; updated_at: string }) => {
                    (window as any).__mockSupabaseState.lastUpsert = payload;
                    (window as any).__mockSupabaseState.upsertCount =
                        ((window as any).__mockSupabaseState.upsertCount || 0) + 1;
                    (window as any).__mockSupabaseState.serverRecord = {
                        salt: payload.salt,
                        data: payload.data,
                        updated_at: payload.updated_at
                    };
                    return { error: null };
                }
            };
            return qb;
        };

        const client = {
            auth: {
                getUser: async () => ({ data: { user: { id: 'user-1', email: 'sync@virgulas.com' } }, error: null })
            },
            from: () => makeQueryBuilder()
        };

        (window as any).supabase = {
            createClient: () => client
        };

        const syncMod = await import('/js/sync.js');
        (window as any).__testSync = syncMod.default;
        (window as any).__testSync.init();
        await (window as any).__testSync.refreshSession();
    }, options);
};

test.describe('Sync merge behavior', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('auto-merges same node when text and description changed on different sides', async ({ page }) => {
        const baseDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T10:00:00.000Z',
            children: [
                {
                    id: 'node-1',
                    text: 'Original title',
                    description: 'Original description',
                    updated_at: '2026-03-19T10:00:00.000Z',
                    children: []
                }
            ]
        };

        const localDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T10:00:01.000Z',
            children: [
                {
                    id: 'node-1',
                    text: 'Local title',
                    description: 'Original description',
                    updated_at: '2026-03-19T10:00:01.000Z',
                    children: []
                }
            ]
        };

        const serverDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T10:00:02.000Z',
            children: [
                {
                    id: 'node-1',
                    text: 'Original title',
                    description: 'Cloud description',
                    updated_at: '2026-03-19T10:00:02.000Z',
                    children: []
                }
            ]
        };

        await setupSyncHarness(page, { baseDoc, localDoc, serverDoc });

        const result = await page.evaluate(async () => {
            return await (window as any).__testSync.checkAndSync((window as any).__testState.doc, (window as any).__testState.key);
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('merged_auto');

        const mergedNode = result.data.children[0];
        expect(mergedNode.text).toBe('Local title');
        expect(mergedNode.description).toBe('Cloud description');
    });

    test('auto-merges same node when local changes parent and cloud adds children', async ({ page }) => {
        const baseDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T11:00:00.000Z',
            children: [
                {
                    id: 'parent-a',
                    text: 'Parent A',
                    updated_at: '2026-03-19T11:00:00.000Z',
                    children: [
                        {
                            id: 'child-1',
                            text: 'Child 1',
                            updated_at: '2026-03-19T11:00:00.000Z',
                            children: []
                        }
                    ]
                },
                {
                    id: 'parent-b',
                    text: 'Parent B',
                    updated_at: '2026-03-19T11:00:00.000Z',
                    children: []
                }
            ]
        };

        const localDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T11:00:01.000Z',
            children: [
                {
                    id: 'parent-b',
                    text: 'Parent B',
                    updated_at: '2026-03-19T11:00:01.000Z',
                    children: [
                        {
                            id: 'parent-a',
                            text: 'Parent A',
                            updated_at: '2026-03-19T11:00:01.000Z',
                            children: [
                                {
                                    id: 'child-1',
                                    text: 'Child 1',
                                    updated_at: '2026-03-19T11:00:01.000Z',
                                    children: []
                                }
                            ]
                        }
                    ]
                }
            ]
        };

        const serverDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T11:00:02.000Z',
            children: [
                {
                    id: 'parent-a',
                    text: 'Parent A',
                    updated_at: '2026-03-19T11:00:02.000Z',
                    children: [
                        {
                            id: 'child-1',
                            text: 'Child 1',
                            updated_at: '2026-03-19T11:00:02.000Z',
                            children: []
                        },
                        {
                            id: 'child-2',
                            text: 'Child 2',
                            updated_at: '2026-03-19T11:00:02.000Z',
                            children: []
                        }
                    ]
                },
                {
                    id: 'parent-b',
                    text: 'Parent B',
                    updated_at: '2026-03-19T11:00:02.000Z',
                    children: []
                }
            ]
        };

        await setupSyncHarness(page, { baseDoc, localDoc, serverDoc });

        const result = await page.evaluate(async () => {
            return await (window as any).__testSync.checkAndSync((window as any).__testState.doc, (window as any).__testState.key);
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('merged_auto');

        const movedParent = (result.data.children || []).find((n: any) => n.id === 'parent-b');
        const movedNode = (movedParent?.children || []).find((n: any) => n.id === 'parent-a');
        const addedChild = (movedNode?.children || []).find((n: any) => n.id === 'child-2');

        expect(!!movedNode).toBe(true);
        expect(!!addedChild).toBe(true);
    });

    test('same-field conflicts allow per-node cloud choice while preserving other auto-merged fields', async ({ page }) => {
        const baseDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T12:00:00.000Z',
            children: [
                {
                    id: 'node-1',
                    text: 'Base title',
                    description: 'Base description',
                    updated_at: '2026-03-19T12:00:00.000Z',
                    children: []
                }
            ]
        };

        const localDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T12:00:01.000Z',
            children: [
                {
                    id: 'node-1',
                    text: 'Local title',
                    description: 'Local description',
                    updated_at: '2026-03-19T12:00:01.000Z',
                    children: []
                }
            ]
        };

        const serverDoc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: '2026-03-19T12:00:02.000Z',
            children: [
                {
                    id: 'node-1',
                    text: 'Cloud title',
                    description: 'Base description',
                    updated_at: '2026-03-19T12:00:02.000Z',
                    children: []
                }
            ]
        };

        await setupSyncHarness(page, { baseDoc, localDoc, serverDoc });

        const result = await page.evaluate(async () => {
            (window as any).__testSync.conflictCallback = async (payload: any) => {
                if (payload?.type === 'field-merge') {
                    return { choice: 'merge', choices: { 'node-1': 'server' } };
                }
                return 'local';
            };

            return await (window as any).__testSync.checkAndSync((window as any).__testState.doc, (window as any).__testState.key);
        });

        expect(result.success).toBe(true);
        expect(result.action).toBe('merged_user');

        const mergedNode = result.data.children[0];
        expect(mergedNode.text).toBe('Cloud title');
        expect(mergedNode.description).toBe('Local description');
    });

    test('no-op when server and local timestamps are equal (no full download)', async ({ page }) => {
        const ts = '2026-03-19T13:00:00.000Z';
        const doc: OutlineDoc = {
            id: 'root',
            text: 'My Notes',
            updated_at: ts,
            children: [{ id: 'n1', text: 'Hello', updated_at: ts, children: [] }]
        };

        await setupSyncHarness(page, { baseDoc: doc, localDoc: doc, serverDoc: doc });

        // Monkey-patch download to detect if it is called.
        const result = await page.evaluate(async () => {
            let downloadCalled = false;
            const originalDownload = (window as any).__testSync.download;
            (window as any).__testSync.download = async () => { downloadCalled = true; return originalDownload(); };

            const r = await (window as any).__testSync.checkAndSync(
                (window as any).__testState.doc,
                (window as any).__testState.key
            );
            return { action: r.action, downloadCalled };
        });

        expect(result.action).toBe('none');
        expect(result.downloadCalled).toBe(false);
    });

    test('fetchServerTimestamp returns server updated_at without downloading full data', async ({ page }) => {
        const ts = '2026-03-19T14:00:00.000Z';
        const doc: OutlineDoc = {
            id: 'root', text: 'My Notes', updated_at: ts,
            children: [{ id: 'n1', text: 'Node', updated_at: ts, children: [] }]
        };

        await setupSyncHarness(page, { baseDoc: doc, localDoc: doc, serverDoc: doc });

        const result = await page.evaluate(async () => {
            let fullRowFetched = false;
            // Spy: if the full record (including 'data') is returned, the select was not lightweight.
            const origFrom = (window as any).__testSync.client.from.bind((window as any).__testSync.client);
            (window as any).__testSync.client.from = (...args: any[]) => {
                const qb = origFrom(...args);
                const origSingle = qb.single.bind(qb);
                qb.single = async () => {
                    const res = await origSingle();
                    if (res.data && 'data' in res.data) fullRowFetched = true;
                    return res;
                };
                return qb;
            };

            const ts = await (window as any).__testSync.fetchServerTimestamp();
            return { ts, fullRowFetched };
        });

        expect(result.ts).toBe(ts);
        expect(result.fullRowFetched).toBe(false);
    });

    test('_lastServerUpdatedAt is set after checkAndSync', async ({ page }) => {
        const ts = '2026-03-19T15:00:00.000Z';
        const doc: OutlineDoc = {
            id: 'root', text: 'My Notes', updated_at: ts,
            children: [{ id: 'n1', text: 'Node', updated_at: ts, children: [] }]
        };

        await setupSyncHarness(page, { baseDoc: doc, localDoc: doc, serverDoc: doc });

        const lastTs = await page.evaluate(async () => {
            (window as any).__testSync._lastServerUpdatedAt = null;
            await (window as any).__testSync.checkAndSync(
                (window as any).__testState.doc,
                (window as any).__testState.key
            );
            return (window as any).__testSync._lastServerUpdatedAt;
        });

        expect(lastTs).toBe(ts);
    });

    test('debounced triggerBackgroundUpload batches rapid writes into one upload', async ({ page }) => {
        const ts = '2026-03-19T16:00:00.000Z';
        const doc: OutlineDoc = {
            id: 'root', text: 'My Notes', updated_at: ts,
            children: [{ id: 'n1', text: 'Node', updated_at: ts, children: [] }]
        };

        await setupSyncHarness(page, { baseDoc: doc, localDoc: doc, serverDoc: doc });

        // Reset upsertCount, then fire 5 rapid uploads.
        await page.evaluate(async () => {
            (window as any).__mockSupabaseState.upsertCount = 0;
            const sync = (window as any).__testSync;
            const key = (window as any).__testState.key;
            const d = (window as any).__testState.doc;
            sync.triggerBackgroundUpload(d, key);
            sync.triggerBackgroundUpload(d, key);
            sync.triggerBackgroundUpload(d, key);
            sync.triggerBackgroundUpload(d, key);
            sync.triggerBackgroundUpload(d, key);
        });

        // Wait for the debounce timer (800ms) to fire, plus a buffer.
        await page.waitForTimeout(1200);

        const upsertCount = await page.evaluate(() => (window as any).__mockSupabaseState.upsertCount);
        expect(upsertCount).toBe(1);
    });
});

