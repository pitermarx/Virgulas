import { test, expect, encryptMockDoc, installMockSupabase, unlockRemote, editFirstNodeText, type Page } from '../test';

/**
 * Storage-seam end-to-end (docs/storage-interface.md §10): unlock, autosave
 * and the head-token poll flow against a fake remote injected through the
 * window.supabase seam.
 *
 * The centerpiece is the sync-01 regression: a remote rotated on another
 * device (foreign salt) locks the stale device and prompts for the new
 * passphrase, and is never silently overwritten by the next local push.
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
        resetStorage: true,
        speedUpPolling: true,
        userId: 'u1'
    });
    await page.goto('/');
    await unlockRemote(page, { email: 'a@b.com', password: 'pw123456', passphrase: PASSPHRASE });
};

const upsertCount = (page: Page) => page.evaluate(() => (window as any).__mockSupabase.upserts.length);

test.describe('storage seam — remote flows', () => {
    test('unlock renders the remote document; edits push with the cached-session uid', async ({ page }) => {
        await bootRemote(page);

        await expect(page.locator('.node-text-md').first()).toHaveText('Start');

        const before = await upsertCount(page);
        await editFirstNodeText(page, 'Seam edit');
        await page.locator('body').click();

        await expect.poll(() => upsertCount(page), { timeout: 10000 }).toBeGreaterThan(before);

        // Identity binding (docs §4.2): the uid is sourced from the locally cached
        // session by the adapter — never supplied by the orchestration, and the
        // salt rides with the record for the encrypted decorator.
        const last = await page.evaluate(() => {
            const upserts = (window as any).__mockSupabase.upserts;
            return upserts[upserts.length - 1];
        });
        expect(last.user_id).toBe('u1');
        expect(typeof last.salt).toBe('string');
        expect(typeof last.updated_at).toBe('string');
    });

    test('a failed device-local cache write leaves the remote save standing and says so', async ({ page }) => {
        // Simulate a full browser storage quota for the document slot only: every
        // other slot (session, sync head) keeps working, like a real quota failure
        // on the one large value.
        await page.addInitScript(() => {
            const nativeSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
                if (key === 'vmd_data_enc' && (window as any).__failLocalCache) {
                    throw new DOMException('Quota exceeded', 'QuotaExceededError');
                }
                return nativeSetItem.call(this, key, value);
            };
        });
        await bootRemote(page);

        // The offline cache cannot take the next save; the server row still can.
        await page.evaluate(() => { (window as any).__failLocalCache = true; });
        const before = await upsertCount(page);
        await editFirstNodeText(page, 'Cache quota edit');
        await page.locator('body').click();

        await expect.poll(() => upsertCount(page), { timeout: 10000 }).toBeGreaterThan(before);
        await expect(page.locator('.status-save-failed')).toHaveText('Not saved locally');
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: save-failed');

        // A later successful local write clears the state.
        await page.evaluate(() => { (window as any).__failLocalCache = false; });
        await editFirstNodeText(page, 'Cache recovered');
        await page.locator('body').click();

        await expect(page.locator('.status-save-failed')).toHaveCount(0);
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: synced', { timeout: 10000 });
    });

    test('a remote rotated on another device locks and prompts without pushing (sync-01)', async ({ page }) => {
        await bootRemote(page);
        const upsertsBeforeRotation = await upsertCount(page);

        // Rotate on "another device": the row now carries a foreign salt and a
        // document encrypted under a different passphrase.
        await page.evaluate(async () => {
            const app: any = (await import('/js/app.js' as string)).e2e;
            const foreignSalt = btoa(String.fromCharCode(...window.crypto.getRandomValues(new Uint8Array(16))));
            const data = await app.encrypt('Rotated elsewhere', 'other-pass-123', foreignSalt);
            (window as any).__mockSupabase.serverRecord = { salt: foreignSalt, data, updated_at: new Date().toISOString() };
        });

        // The next poll pulls, meets the foreign salt, and locks with a prompt
        // instead of pulling-then-pushing over the rotation.
        await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(/changed on another device/i)).toBeVisible();

        // ...and no push followed the failed pull (docs §4.4: never followed by a
        // push). The locked screen is the end of the pull cycle, so a push issued
        // by that cycle would already be recorded — no observation window needed.
        expect(await upsertCount(page)).toBe(upsertsBeforeRotation);
    });

    test('the document-size quota reminder warns, dismisses, and re-arms on escalation', async ({ page }) => {
        await bootRemote(page);

        // The remote unlock resolves the account budget: no plan row, so the
        // free default (1 MiB) binds, not the browser quota.
        await expect(page.locator('.quota-donut')).toHaveAttribute('title', /of 1.0 MB plan cap/, { timeout: 10000 });

        // Near the limit (~67% of the plan cap): a dismissible reminder.
        await page.evaluate(async () => {
            (await import('/js/app.js' as string)).e2e.noteSlotChars(700_000);
        });
        const reminder = page.locator('.storage-persistence-notice', { hasText: 'getting large' });
        await expect(reminder).toBeVisible();
        await expect(page.locator('.quota-donut')).toHaveAttribute('title', /684 KB of 1.0 MB plan cap \(67%\)/);

        // A dismissal is remembered: a later save at the same level stays quiet.
        await page.locator('[aria-label="Dismiss size reminder"]').click();
        await expect(reminder).toBeHidden();
        await page.evaluate(async () => {
            (await import('/js/app.js' as string)).e2e.noteSlotChars(710_000);
        });
        await expect(reminder).toBeHidden();

        // Escalating near the critical level re-arms it as the stronger alert,
        // and the ring goes red.
        await page.evaluate(async () => {
            (await import('/js/app.js' as string)).e2e.noteSlotChars(1_020_000);
        });
        const alert = page.locator('.storage-persistence-notice[role="alert"]');
        await expect(alert).toBeVisible();
        await expect(alert).toContainText('next save may fail');
    });

    test('edits that only reached the offline cache survive a re-unlock', async ({ page }) => {
        await bootRemote(page);
        await page.evaluate(() => { (window as any).__retryBaseMs = 30; });

        // Cut the server off: the next edit reaches the durable local copy (the
        // offline cache) but every push fails.
        await page.evaluate(() => { (window as any).__mockSupabase.failUpserts = true; });
        const before = await upsertCount(page);
        await editFirstNodeText(page, 'Offline edit');
        await page.locator('body').click();

        // The push ran and failed; the edit lives in the cache only.
        await expect.poll(() => upsertCount(page), { timeout: 10000 }).toBeGreaterThan(before);
        await expect(page.locator('.sync-dot')).toHaveAttribute('title', 'Sync: error', { timeout: 10000 });

        // Close and reopen the tab: the session ends on the device, but the
        // offline cache row — the durable local copy — stays. (The explicit
        // sign-out action purges it by design, priv-01, so it is not the path
        // under test.)
        await page.reload();

        // The server row never got the edit. Before the cache merge, this unlock
        // loaded the server row and overwrote the cache with it — the edit was
        // silently destroyed. Now the two documents merge.
        await page.evaluate(() => { (window as any).__mockSupabase.failUpserts = false; });
        await unlockRemote(page, { email: 'a@b.com', password: 'pw123456', passphrase: PASSPHRASE });

        await expect(page.locator('.node-text-md').first()).toHaveText('Offline edit');
    });
});
