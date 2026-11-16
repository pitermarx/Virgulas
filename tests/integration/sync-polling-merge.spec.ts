import { test, expect, encryptMockDoc, installMockSupabase, unlockRemote, type Page } from '../test';

/**
 * The background poll against a mocked remote: it starts after a Remote unlock,
 * stops at lock and sign-out, pauses while conflicts are pending, and never
 * writes back a merged document the remote already holds.
 *
 * The merge algorithm itself is covered by the unit suites (`merge.test.ts`,
 * `sync.test.ts`); these specs only exercise the browser-side scheduling.
 */
const PASSPHRASE = 'sync-pass';

const bootRemote = async (page: Page) => {
    const record = await encryptMockDoc(
        { id: 'root', text: 'Root', children: [{ id: 'n1', text: 'Sync Node', children: [] }] },
        PASSPHRASE
    );
    await installMockSupabase(page, {
        downloadData: record,
        rememberedMode: 'remote',
        resetStorage: true,
        // Every head probe reports a fresh timestamp, so each poll pulls.
        headAdvances: true,
        speedUpPolling: true,
        userEmail: 'poll@test.com'
    });
    await page.goto('/');
    await unlockRemote(page, { email: 'poll@test.com', password: 'pass', passphrase: PASSPHRASE });
};

const headCalls = (page: Page) => page.evaluate(() => (window as any).__mockSupabase.headCalls);
const upsertCount = (page: Page) => page.evaluate(() => (window as any).__mockSupabase.upsertCallCount);

test.describe('Sync polling', () => {
    test('starts after a remote unlock and stops at lock', async ({ page }) => {
        await bootRemote(page);

        await expect.poll(() => headCalls(page), { timeout: 10000, intervals: [100] }).toBeGreaterThan(0);

        await page.evaluate(async () => {
            const persistence = (await import('/js/app.js' as string)).e2e.persistence;
            persistence.lock();
        });
        await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();

        const baseline = await headCalls(page);
        await expect.poll(
            () => headCalls(page).then(count => count - baseline),
            { timeout: 10000, intervals: [200, 200, 200, 200] }
        ).toBeLessThanOrEqual(1);
    });

    test('a pull whose merged document matches the remote does not write it back', async ({ page }) => {
        await bootRemote(page);
        const pollBaseline = await headCalls(page);
        const upsertBaseline = await upsertCount(page);

        await expect.poll(
            () => headCalls(page).then(count => count - pollBaseline),
            { timeout: 10000, intervals: [100] }
        ).toBeGreaterThanOrEqual(2);

        // Every poll pulls; none may create a new revision.
        await expect.poll(() => upsertCount(page), { timeout: 5000, intervals: [100] }).toBe(upsertBaseline);
    });

    test('stops after the remote sign-out flow', async ({ page }) => {
        await bootRemote(page);
        await expect.poll(() => headCalls(page), { timeout: 10000, intervals: [100] }).toBeGreaterThan(0);

        await page.getByRole('button', { name: 'Options' }).click();
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect(page.locator('.status-memory-badge')).toBeVisible({ timeout: 5000 });

        const baseline = await headCalls(page);
        await expect.poll(
            () => headCalls(page).then(count => count - baseline),
            { timeout: 10000, intervals: [200, 200, 200, 200] }
        ).toBeLessThanOrEqual(1);
    });

    test('pauses while conflicts are pending and resumes after resolution', async ({ page }) => {
        await bootRemote(page);
        await expect.poll(() => headCalls(page), { timeout: 10000, intervals: [100] }).toBeGreaterThan(0);

        await page.evaluate(async () => {
            const { pendingConflicts } = (await import('/js/app.js' as string)).e2e;
            pendingConflicts.value = [{
                nodeId: 'n1',
                nodeText: 'Sync Node',
                field: 'text',
                localValue: 'Local Value',
                remoteValue: 'Remote Value'
            }];
        });
        // A poll already in flight when the conflict was published may still
        // probe once; measure from after the publish.
        const baseline = await headCalls(page);
        await expect.poll(
            () => headCalls(page).then(count => count - baseline),
            { timeout: 3000, intervals: [120, 120, 120, 120] }
        ).toBeLessThanOrEqual(1);

        await page.evaluate(async () => {
            const { pendingConflicts } = (await import('/js/app.js' as string)).e2e;
            pendingConflicts.value = [];
        });

        await expect.poll(() => headCalls(page), { timeout: 10000, intervals: [100] }).toBeGreaterThan(baseline);
    });
});
