import {
    test,
    expect,
    type Page,
    encryptMockDoc,
    installMockSupabase,
    unlockRemote,
    editFirstNodeText,
    setFirstNodeTextViaModel,
    remoteFirstNodeText
} from '../test';

/** The document every payload starts from: one node, "Sync Test Node". */
const syncDoc = { id: 'root', text: 'Root', children: [{ id: 'n1', text: 'Sync Test Node', children: [] }] };

// ─── adapters kept for the call sites below ───────────────────────────────────

/** The mock network fails the scripted upserts with the accelerated backoff. */
const installFailingMockSupabase = (page: Page, options: Parameters<typeof installMockSupabase>[1] = {}) =>
    installMockSupabase(page, { rememberedMode: 'remote', retryBaseMs: 30, ...options });

/** Encrypt the standard sync document (runner-side, no page load). */
const buildEncryptedPayload = (_page: Page, passphrase: string) => encryptMockDoc(syncDoc, passphrase);

/** Unlock with the four-argument shape the sync tests use. */
const unlockSync = (page: Page, email: string, accountPass: string, passphrase: string) =>
    unlockRemote(page, { email, password: accountPass, passphrase });

const editFirstNode = (page: Page, text: string) => editFirstNodeText(page, text);

const updateFirstNodeViaModel = (page: Page, text: string) => setFirstNodeTextViaModel(page, text);

const readRemoteFirstNodeText = (page: Page, passphrase: string) => remoteFirstNodeText(page, passphrase);

test.describe('Sync status indicator', () => {
    test('sync-dot shows synced after a successful remote upload', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, { userEmail: 'user@test.com', downloadData: payload });
        // Use a very short retry base delay so the test runs quickly
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Synced Edit');

        // After debounce (1s) + successful upload, dot should settle on 'synced'
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 10000 });
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
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Error Edit');

        // debounce (1s) + 3 retries × base ≈ 30+60+120 ms = well under 1s extra
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 10000 });
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
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Offline Edit');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: offline', { timeout: 10000 });
    });

    test('sync-dot transitions syncing → synced during upload', async ({ page }) => {
        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });

        // Delay the first upsert so Playwright can observe the 'syncing' state.
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            firstUpsertDelayMs: 3000
        });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');

        await editFirstNode(page, 'Transition Edit');

        // Wait for the debounce to fire and upload to start
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: syncing', { timeout: 10000 });
        // Then wait for the upload to complete (3 s delay in the mock). Leave
        // the timeout to the suite default: 6 s was too tight on a loaded machine.
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced');
    });

    test('debounces rapid edits into one final remote upload', async ({ page }) => {
        await page.goto('/');
        const passphrase = 'sync-pass';
        const payload = await buildEncryptedPayload(page, passphrase);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, { userEmail: 'user@test.com', downloadData: payload });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);
        // The unlock itself arms one save; settle it so it cannot pollute the count.
        const baseline = await page.evaluate(() => (window as any).__mockSupabase.upsertCallCount);

        // Two edits in quick succession: the second lands before the write
        // debounce fires, so only the final text may be uploaded. No sleep
        // between them — a fixed wait is what made this flaky under load.
        await editFirstNode(page, 'First Draft');
        await updateFirstNodeViaModel(page, 'Final Draft');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 5000 });
        await expect.poll(
            () => page.evaluate((base) => (window as any).__mockSupabase.upsertCallCount - base, baseline),
            { timeout: 5000, intervals: [100] }
        ).toBe(1);

        await expect(await readRemoteFirstNodeText(page, passphrase)).toBe('Final Draft');
    });

    test('a new write supersedes a slow in-flight upload', async ({ page }) => {
        await page.goto('/');
        const passphrase = 'sync-pass';
        const payload = await buildEncryptedPayload(page, passphrase);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        // The first upload is slow, so the second edit lands while it is in flight.
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            firstUpsertDelayMs: 2500
        });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);

        await editFirstNode(page, 'First Upload');
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: syncing', { timeout: 10000 });

        await updateFirstNodeViaModel(page, 'Second Upload');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 8000 });
        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabase.upsertCallCount),
            { timeout: 8000, intervals: [100] }
        ).toBe(2);

        await expect(await readRemoteFirstNodeText(page, passphrase)).toBe('Second Upload');
    });

    test('background sync waits until typing stops', async ({ page }) => {
        await page.goto('/');
        const passphrase = 'sync-pass';
        const payload = await buildEncryptedPayload(page, passphrase);

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload,
            speedUpPolling: true
        });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);

        // Four edits back to back stay inside the write debounce; no upload may
        // start while the edits keep coming.
        for (const text of ['Typing 1', 'Typing 2', 'Typing 3', 'Typing 4']) {
            await updateFirstNodeViaModel(page, text);
        }

        const duringTypingUploads = await page.evaluate(() => (window as any).__mockSupabase.upsertCallCount);
        expect(duringTypingUploads).toBe(0);

        await expect.poll(
            () => page.evaluate(() => (window as any).__mockSupabase.upsertCallCount),
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
            downloadData: payload
        });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');
        // Let the save the unlock arms finish, then start the failure script so
        // only this edit's uploads are counted.
        const baselineCalls = await page.evaluate(() => (window as any).__mockSupabase.upsertCallCount);
        await page.evaluate((failTimes) => { (window as any).__mockSupabase.failUpsertTimes = failTimes; }, FAIL_TIMES);

        await editFirstNode(page, 'Retry Edit');

        // The sync-dot starts at 'synced' (initial value), so we must NOT check for 'synced'
        // before confirming the upload actually ran. Use expect.poll to wait for all retries.
        await expect.poll(
            () => page.evaluate((baseline) => (window as any).__mockSupabase.upsertCallCount - baseline, baselineCalls),
            { timeout: 10000, intervals: [100] }
        ).toBeGreaterThanOrEqual(FAIL_TIMES + 1);

        // After FAIL_TIMES failures + 1 success the dot should settle on 'synced'
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 10000 });

        // upsert was called FAIL_TIMES + 1 (the final successful attempt)
        const callDelta = await page.evaluate((baseline) => (window as any).__mockSupabase.upsertCallCount - baseline, baselineCalls);
        expect(callDelta).toBe(FAIL_TIMES + 1);
    });

    test('abandons upload after max retries and records all attempts', async ({ page }) => {
        const MAX_RETRIES = 3; // must match retryWithBackoff default maxRetries

        await page.goto('/');
        const payload = await buildEncryptedPayload(page, 'sync-pass');

        await page.evaluate(() => { localStorage.clear(); localStorage.setItem('vmd_last_mode', 'local'); });
        await installFailingMockSupabase(page, {
            userEmail: 'user@test.com',
            downloadData: payload
        });
        await page.addInitScript(() => { (window as any).__retryBaseMs = 30; });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');
        const baselineCalls = await page.evaluate(() => (window as any).__mockSupabase.upsertCallCount);
        await page.evaluate(() => { (window as any).__mockSupabase.failUpserts = true; });

        await editFirstNode(page, 'Exhaust Retries');

        // Wait for all retries to exhaust: 1000ms debounce + 30+60+120 = 210ms retries
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 10000 });

        // Exactly 1 (initial attempt) + MAX_RETRIES calls were made
        const callDelta = await page.evaluate((baseline) => (window as any).__mockSupabase.upsertCallCount - baseline, baselineCalls);
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
            (window as any).__mockSupabase = state;

            const sessionState = { user: { id: 'u', email: 'user@test.com' } as any };
            const queryBuilder = {
                select: () => queryBuilder, eq: () => queryBuilder,
                single: async () => ({ data: state.serverRecord, error: null }),
                upsert: (p: any) => {
                    state.upsertCallCount++;
                    return {
                        select: () => ({
                            single: async () => {
                                if ((window as any).__shouldUpsertFail) {
                                    return { data: null, error: { message: 'network error', code: '503' } };
                                }
                                state.serverRecord = { ...p, updated_at: p.updated_at };
                                return { data: { updated_at: p.updated_at }, error: null };
                            }
                        })
                    };
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
                    getSession: async () => ({ data: { session: sessionState.user ? { user: sessionState.user } : null }, error: null }),
                    getUser: async () => ({ data: { user: sessionState.user }, error: null })
                },
                from: () => queryBuilder
            };
            Object.defineProperty(window, 'supabase', { configurable: true, get: () => ({ createClient: () => client }), set: () => { } });
            localStorage.setItem('backendconfig', JSON.stringify({ backend: 'supabase', url: 'http://127.0.0.1:54321', key: 'anon' }));
            localStorage.setItem('vmd_last_mode', 'remote');
        }, { downloadData: payload });

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', 'sync-pass');

        // Edit while upsert is failing → error state
        await editFirstNode(page, 'Failing Write');
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 5000 });

        // Fix the flag so next upload succeeds, then make another UI edit.
        await page.evaluate(() => { (window as any).__shouldUpsertFail = false; });

        await editFirstNode(page, 'Recovered Write');

        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 10000 });
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
            const { encrypt } = (await import('/js/app.js' as string)).e2e;
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
            const { encrypt } = (await import('/js/app.js' as string)).e2e;
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
 * Boot with `payload` on the server, and hand back a call that replaces the row
 * with `remotePayload` — another device publishing while this one is open.
 * Publishing after unlock is what makes the next save see a changed head.
 */
const installMockWithRemoteUpdate = async (
    page: Page,
    payload: { salt: string; data: string },
    remotePayload: { salt: string; data: string }
) => {
    await installMockSupabase(page, {
        downloadData: payload,
        userEmail: 'user@test.com',
        rememberedMode: 'remote',
        retryBaseMs: 30
    });
    return () => page.evaluate((remote: { salt: string; data: string }) => {
        (window as any).__mockSupabase.serverRecord = {
            ...remote,
            updated_at: new Date(Date.now() + 60_000).toISOString()
        };
    }, remotePayload);
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
                const { encrypt } = (await import('/js/app.js' as string)).e2e;
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
        const publishRemote = await installMockWithRemoteUpdate(page, localPayload, remotePayload);

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);
        await publishRemote();

        // Zoom into n1 and edit it. Sync merge-apply should not reset zoom to root.
        await page.evaluate(async () => {
            const outline = (await import('/js/app.js' as string)).e2e.outline as any;
            outline.zoomIn('n1');
            outline.updateNode('n1', { text: 'Local Edit' });
        });

        // After merge: both n1 (local edit) and n2 (remote-only) should be present; no modal
        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 10000 });
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 5000 });
        await expect.poll(
            () => page.evaluate(async () => {
                const outline = (await import('/js/app.js' as string)).e2e.outline as any;
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
        const publishRemote = await installMockWithRemoteUpdate(page, localPayload, remotePayload);

        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);
        await publishRemote();

        // Edit the local node via UI - this sets n1.lastModified = Date.now() > lastSyncedAt AND triggers sync
        await editFirstNode(page, 'Local Version');

        // Conflict modal should appear (local and remote both changed n1 after last sync)
        await expect(page.locator('.conflict-overlay')).toBeVisible();
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
        const publishRemote = await installMockWithRemoteUpdate(page, localPayload, remotePayload);
        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);
        await publishRemote();

        // Edit the local node via UI — sets n1.lastModified = Date.now() > lastSyncedAt AND triggers sync
        await editFirstNode(page, localText);

        // Wait for modal
        await expect(page.locator('.conflict-overlay')).toBeVisible();
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

    test('a backdrop or foreign close click does not dismiss the blocking conflict dialog', async ({ page }) => {
        await setupConflict(page, 'Stay A', 'Stay B');
        const dialog = page.getByRole('dialog', { name: /Sync conflict|conflict/i });
        await expect(dialog).toBeVisible();

        // Clicking the backdrop (outside the dialog) leaves the blocking dialog up.
        await page.locator('.conflict-overlay').click({ position: { x: 4, y: 4 } });
        await expect(dialog).toBeVisible();

        // A close-button click elsewhere in the document must not hide it either:
        // the document-level closeModals handler skips the blocking dialog.
        await page.evaluate(() => {
            const button = document.createElement('button');
            button.className = 'modal-close';
            document.body.appendChild(button);
            button.click();
            button.remove();
        });
        await expect(dialog).toBeVisible();
    });

    test('the conflict dialog is blocking: it owns focus, keeps Tab inside, and ignores Escape (a11y-02)', async ({ page }) => {
        await setupConflict(page, 'Blocked A', 'Blocked B');
        const dialog = page.getByRole('dialog', { name: /Sync conflict|conflict/i });
        await expect(dialog).toBeVisible();

        // Focus moved into the dialog on its own.
        await expect
            .poll(() => page.evaluate(() => !!document.activeElement?.closest('.conflict-dialog')))
            .toBe(true);

        // The outline behind it is inert, so it cannot be reached or typed into.
        expect(
            await page.evaluate(() => {
                const main = document.getElementById('main-content') as HTMLElement & { inert?: boolean };
                return main.hasAttribute('inert') || main.inert === true;
            }),
            'the outline is inert behind the conflict dialog'
        ).toBe(true);

        // Tab and Shift+Tab cycle inside it.
        for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
            await page.keyboard.press(key);
            await expect
                .poll(() => page.evaluate(() => !!document.activeElement?.closest('.conflict-dialog')), key + ' stays inside')
                .toBe(true);
        }

        // Escape must not dismiss a blocking dialog.
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
    });

    test('the outline shortcuts do not run behind the blocking dialog (ux-01)', async ({ page }) => {
        await setupConflict(page, 'Behind A', 'Behind B');
        await expect(page.locator('.conflict-overlay')).toBeVisible();

        const readDoc = () => page.evaluate(async () => (await import('/js/app.js' as string)).e2e.outline.serialize());
        const readFocusedNodes = () => page.evaluate(() =>
            Array.from(document.querySelectorAll('.node-focused')).map(node => node.getAttribute('data-node-id')).join(','));

        // The keys must arrive once the dialog owns focus and the app has finished
        // reacting to the blur: opening the dialog blurs the outline's input, and
        // the app clears the focused node 75 ms later (focus.ts, scheduleBlurClear).
        // Snapshotting before that settle compared a focused node with the cleared
        // one — a race that failed on a slow WebKit worker, not a shortcut leak.
        await expect
            .poll(() => page.evaluate(() => !!document.activeElement?.closest('.conflict-dialog')),
                { message: 'the dialog owns focus before the keys are sent' })
            .toBe(true);
        await expect
            .poll(readFocusedNodes, { message: 'the outline focus behind the dialog has settled' })
            .toBe('');

        const before = await readDoc();
        const focusedBefore = await readFocusedNodes();
        const urlBefore = page.url();

        // Keys the outline would act on must not reach it: ArrowDown moves the
        // outline focus, Enter would add a node and Backspace would delete an
        // empty one. Tab and Escape belong to the dialog.
        for (const key of ['ArrowDown', 'ArrowDown', 'Enter', 'Tab', 'Backspace', 'Escape']) {
            await page.keyboard.press(key);
        }

        // Backspace must not reach the browser either: WebKit turns an unhandled
        // one into a history navigation, which would leave the app from here.
        expect(page.url(), 'the browser did not navigate away').toBe(urlBefore);
        expect(await page.locator('#main-content').count(), 'the app is still on the page').toBe(1);

        const focusedAfter = await readFocusedNodes();
        expect(focusedAfter, 'the outline selection does not move').toBe(focusedBefore);
        expect(await readDoc(), 'nothing behind the dialog edits the document').toBe(before);
        await expect(page.locator('.conflict-overlay')).toBeVisible();
    });

    test('shows both values, requires every conflict, and a local choice closes it', async ({ page }) => {
        await setupConflict(page, 'My local text', 'My remote text');

        // Both sides are shown, labelled with the field.
        await expect(page.locator('.conflict-field-label')).toHaveText(/text/i);
        await expect(page.locator('.conflict-value-textarea').first()).toContainText('My local text');
        await expect(page.locator('.conflict-value-textarea').last()).toContainText('My remote text');

        // The dialog blocks the app but is not an error state.
        await expect(page.locator('.sync-dot')).not.toHaveAttribute('title', 'Sync: error');
        const applyBtn = page.getByRole('button', { name: 'Apply' });
        await expect(applyBtn).toBeDisabled();

        await page.locator('.conflict-keep-btn').first().click();  // Keep local
        await expect(applyBtn).toBeEnabled();
        await applyBtn.click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 10000 });
        await expect(page.locator('.node-text-md').first()).toContainText('My local text');
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 10000 });
    });

    test('"Keep remote" resolves to remote value and Apply closes modal', async ({ page }) => {
        await setupConflict(page, 'Local Loses', 'Remote Wins');

        // "Keep remote" is the second .conflict-keep-btn in each conflict-side
        await page.locator('.conflict-keep-btn').nth(1).click();
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 10000 });
        await expect(page.locator('.node-text-md').first()).toContainText('Remote Wins');
    });

    test('"Use all local" resolves every conflict to local and enables Apply', async ({ page }) => {
        await setupConflict(page, 'AllLocal', 'AllRemote');

        await page.getByRole('button', { name: 'Use all local' }).click();
        const applyBtn = page.getByRole('button', { name: 'Apply' });
        await expect(applyBtn).toBeEnabled();
        await applyBtn.click();
        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 10000 });
        await expect(page.locator('.node-text-md').first()).toContainText('AllLocal');
    });

    test('"Use all remote" resolves every conflict to remote', async ({ page }) => {
        await setupConflict(page, 'Discard', 'Keep This');

        await page.getByRole('button', { name: 'Use all remote' }).click();
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 10000 });
        await expect(page.locator('.node-text-md').first()).toContainText('Keep This');
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
        const publishRemote = await installMockWithRemoteUpdate(page, localPayload, remotePayload);
        await page.reload();
        await unlockSync(page, 'user@test.com', 'pass', passphrase);
        await publishRemote();

        // Add a local child to change `children` on the same parent before sync.
        await page.locator('[data-node-id="n1"] .node-text-md').click();
        await page.locator('[data-node-id="n1"] input').press('Enter');

        await expect(page.locator('.conflict-overlay')).toBeVisible();
        await expect(page.locator('.conflict-field-label')).toHaveText(/children/i);

        await page.locator('.conflict-keep-btn').nth(1).click(); // Keep remote
        await page.getByRole('button', { name: 'Apply' }).click();

        await expect(page.locator('.conflict-overlay')).not.toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Remote Child', { exact: true })).toBeVisible();
        await expect(page.getByText('Local Seed Child', { exact: true })).toHaveCount(0);
    });
});