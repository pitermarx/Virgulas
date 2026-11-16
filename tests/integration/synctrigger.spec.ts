import { test, expect, encryptMockDoc, installMockSupabase, unlockRemote, remoteFirstNodeText, type Page } from '../test';

/**
 * Regression coverage for "editing a node does not trigger a sync".
 *
 * Two compounding causes were fixed:
 *  1. autosave was a pure debounce, so continuous typing postponed the save
 *     indefinitely (and therefore the push);
 *  2. a push deferred while typing was silently dropped instead of retried.
 */
const PASSPHRASE = 'pass-123456';

const bootRemote = async (page: Page) => {
    const record = await encryptMockDoc(
        { id: 'root', text: 'Root', children: [{ id: 'start', text: 'Start', children: [] }] },
        PASSPHRASE
    );
    await installMockSupabase(page, {
        downloadData: record,
        rememberedMode: 'remote',
        resetStorage: true
    });
    await page.goto('/');
    await unlockRemote(page, { email: 'a@b.com', password: 'pw123456', passphrase: PASSPHRASE });
};

const upsertCount = (page: Page) => page.evaluate(() => (window as any).__mockSupabase.upsertCallCount);

test.describe('remote sync is triggered by edits', () => {
    test('editing node text pushes to the server', async ({ page }) => {
        await bootRemote(page);
        const before = await upsertCount(page);

        await page.locator('.node-text-md').first().click();
        await page.locator('.node-content input').first().fill('Edited text');
        await page.locator('body').click();

        await expect.poll(() => upsertCount(page), { timeout: 10000 }).toBeGreaterThan(before);
    });

    test('creating a node pushes to the server', async ({ page }) => {
        await bootRemote(page);
        const before = await upsertCount(page);

        await page.locator('.node-text-md').first().click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.locator('.node-content input').last().fill('Brand new node');
        await page.locator('body').click();

        await expect.poll(() => upsertCount(page), { timeout: 10000 }).toBeGreaterThan(before);
    });

    test('an edit made while typing continuously still reaches the server', async ({ page }) => {
        // Regression: autosave was a pure debounce, so a user who keeps typing never
        // saved or synced; and the deferred push was dropped rather than retried.
        await bootRemote(page);
        const before = await upsertCount(page);

        // Type continuously for ~8s of app time without pausing long enough for the
        // debounce. The fake clock moves app time forward deterministically, so the
        // test does not depend on how loaded the machine is.
        await page.clock.install();
        await page.locator('.node-text-md').first().click();
        const input = page.locator('.node-content input').first();
        for (let i = 0; i < 40; i++) {
            await input.press('End');
            await input.type('z');
            await page.clock.fastForward(200);
        }
        await page.clock.fastForward(1000);

        await expect.poll(() => upsertCount(page), { timeout: 10000 }).toBeGreaterThan(before);
    });

    test('continuous typing saves the document locally while the network push waits', async ({ page }) => {
        // The 3 s maximum-wait save must keep the durable local copy even though
        // SPEC defers uploads until typing pauses. This is why no push queue is
        // needed: the edit is never held only in memory.
        await bootRemote(page);
        // One ordinary edit proves the save path is idle before we measure.
        await page.locator('.node-text-md').first().click();
        await page.locator('.node-content input').first().fill('warm');
        await page.locator('body').click();
        await expect.poll(() => remoteFirstNodeText(page, PASSPHRASE), { timeout: 10000 }).toBe('warm');
        const localBefore = await page.evaluate(() => localStorage.getItem('vmd_data_enc'));

        await page.clock.install();
        await page.locator('.node-text-md').first().click();
        const input = page.locator('.node-content input').first();
        for (let i = 0; i < 20; i++) {
            await input.press('End');
            await input.type('z');
            await page.clock.fastForward(200);
        }
        // Past the 3 s maximum wait, still typing.
        await page.clock.fastForward(400);

        await expect.poll(
            () => page.evaluate(() => localStorage.getItem('vmd_data_enc')),
            { timeout: 5000, intervals: [100] }
        ).not.toBe(localBefore);
    });
});
