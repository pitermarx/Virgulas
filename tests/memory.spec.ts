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

    test('Options hides Upgrade storage and Delete local data in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await page.getByRole('button', { name: 'Options' }).click();
        await expect(page.getByRole('button', { name: /Upgrade storage/i })).not.toBeVisible();
        await expect(page.getByRole('button', { name: 'Delete local data' })).not.toBeVisible();
    });

    test('Options shows app version', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        const expectedVersion = await page.locator('meta[name="app-version"]').getAttribute('content');
        expect(expectedVersion).toBeTruthy();

        await page.getByRole('button', { name: 'Options' }).click();
        await expect(page.locator('[data-app-version]')).toHaveText(expectedVersion || '');
    });

    test('Enable Secure Storage banner opens the lock screen', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // Upgrade storage now lives in the persistent banner shown while in memory mode
        await page.getByRole('button', { name: /Enable Secure Storage/ }).click();

        await expect(page.getByText('Unlock Virgulas')).toBeVisible({ timeout: 3000 });
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


    test('first-load URL hash deep-link zooms into the correct node', async ({ page }) => {
        // Load in memory mode (no localStorage)
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // Get the ID of the first real child node from the DOM
        const nodeId = await page.locator('.node-content').first().getAttribute('data-node-id');
        expect(nodeId).toBeTruthy();

        // Simulate "first-load with this hash in the URL":
        // Set the hash to the node ID, then call applyHashZoomIfPresent (the same
        // function called during unlockMemory when the URL has a hash on first load).
        await page.evaluate((id) => {
            window.location.hash = id!;
            (window as any).__applyHashZoomIfPresent?.();
        }, nodeId);

        // Breadcrumbs should be visible because we are now zoomed into that node
        await expect(page.locator('.breadcrumbs')).toBeVisible({ timeout: 3000 });
    });
});
