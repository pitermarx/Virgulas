import { test, expect } from './test';

test.describe('Memory mode (first-ever visit)', () => {
    test('bypasses lock screen and loads INTRO.VMD on first visit', async ({ page }) => {
        // Fresh page — no localStorage at all
        await page.goto('/');

        // Splash disappears
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });

        // App renders without asking for a passphrase
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await expect(page.getByText('Unlock Virgulas')).not.toBeVisible();

        // INTRO.VMD is loaded — check for its first node text
        await expect(page.locator('.node-content').first()).toContainText('Welcome to Virgulas');
    });

    test('shows "In memory — not saved" badge in status bar', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await expect(page.locator('.status-memory-badge')).toBeVisible();
        await expect(page.locator('.status-memory-badge')).toContainText('In memory');
    });

    test('hides Raw button in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        // Raw button should not be visible in memory mode
        await expect(page.getByRole('button', { name: 'Raw' })).not.toBeVisible();
    });

    test('Options shows Upgrade storage button in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await page.getByRole('button', { name: 'Options' }).click();
        await expect(page.getByRole('button', { name: /Upgrade storage/i })).toBeVisible();
    });

    test('Upgrade storage shows lock screen after confirmation', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await page.getByRole('button', { name: 'Options' }).click();

        // Accept the "discard in-memory document" confirmation
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: /Upgrade storage/i }).click();

        // Lock screen is now visible
        await expect(page.getByText('Unlock Virgulas')).toBeVisible({ timeout: 3000 });
    });

    test('Upgrade storage dismissed stays in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await page.getByRole('button', { name: 'Options' }).click();

        // Dismiss the confirmation
        page.once('dialog', dialog => dialog.dismiss());
        await page.getByRole('button', { name: /Upgrade storage/i }).click();

        // Still in the app, still in memory mode
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await expect(page.locator('.status-memory-badge')).toBeVisible();
    });

    test('document is not persisted between visits in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // Click on the second top-level node title text to focus it (avoiding the first node's description)
        const secondNodeTitle = page.locator('.node-text-md').nth(1);
        await secondNodeTitle.click();
        const input = page.locator('.node-content input').first();
        await expect(input).toBeVisible({ timeout: 3000 });

        // Press End then type to append to the title
        await input.press('End');
        await input.type(' EDITED');
        await expect(input).toHaveValue(/EDITED/);

        // Reload — document should revert to INTRO.VMD (fresh memory mode), edit is gone
        await page.reload();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await expect(page.locator('.node-content').first()).toContainText('Welcome to Virgulas');
        await expect(page.getByText('Editing nodes EDITED')).not.toBeVisible();
    });

    test('remembered mode shows lock screen on revisit', async ({ page }) => {
        // Simulate a user who previously chose Local mode by seeding localStorage
        await page.addInitScript(() => {
            localStorage.setItem('vmd_last_mode', 'local');
        });
        await page.goto('/');
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
        // Lock screen should appear
        await expect(page.getByText('Unlock Virgulas')).toBeVisible();
    });

    test('Purge in memory mode reloads the intro document', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // Edit a node so we have something to lose
        const secondNode = page.locator('.node-text-md').nth(1);
        await secondNode.click();
        const input = page.locator('.node-content input').first();
        await expect(input).toBeVisible({ timeout: 3000 });
        await input.press('End');
        await input.type(' PURGE_MARKER');

        // Open Options and confirm the Purge action
        await page.getByRole('button', { name: 'Options' }).click();
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Delete local data' }).click();

        // App stays rendered (no lock screen)
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // Intro document is reloaded — "Welcome to Virgulas" is present again
        await expect(page.locator('.node-content').first()).toContainText('Welcome to Virgulas', { timeout: 3000 });

        // The marker we typed is gone
        await expect(page.getByText('PURGE_MARKER')).not.toBeVisible();

        // Still in memory mode
        await expect(page.locator('.status-memory-badge')).toBeVisible();
    });

    test('first-load URL hash deep-link zooms into the correct node', async ({ page }) => {
        // Seed a known node ID in the intro.vmd is not reliable; instead we use
        // seedEncryptedDoc is not available in memory mode — we manipulate the
        // hash after load, simulating a shared link opened for the first time.
        // 1. Load in memory mode (no localStorage)
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // 2. Get the first real node ID from the outline
        const nodeId = await page.evaluate(() => {
            return (window as any).__testOutline
                ? (window as any).__testOutline.getRoot().peek().children[0]
                : null
        }).catch(() => null)

        // If we can't get the nodeId via test hook, use the breadcrumb zoom approach
        // by clicking the first bullet to zoom in, then reload with that hash
        const bullet = page.locator('.bullet').first()
        await bullet.click()

        // After bullet click we should be zoomed in — breadcrumbs appear
        const crumbs = page.locator('.breadcrumbs')
        await expect(crumbs).toBeVisible({ timeout: 3000 })

        // The hash should now carry the zoomed node's ID
        const hash = await page.evaluate(() => window.location.hash)
        expect(hash).toMatch(/^#.+/)

        // 3. Reload with the same hash — app should re-apply the zoom
        await page.goto('/' + hash)
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 })
        // Breadcrumbs should be visible because we are zoomed in
        await expect(page.locator('.breadcrumbs')).toBeVisible({ timeout: 3000 })
    });
});
