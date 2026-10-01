import { test, expect } from './test';

test.describe('Memory mode (first-ever visit)', () => {
    test('bypasses lock screen and loads INTRO.VMD on first visit', async ({ page }) => {
        // Fresh page — no localStorage at all
        await page.goto('/');

        // Splash disappears
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });

        // App renders without asking for a passphrase
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await expect(page.getByText('Unlock Virgulas')).not.toBeVisible();

        // INTRO.VMD is loaded — check for its first node text
        await expect(page.locator('.node-content').first()).toContainText('Welcome to Virgulas');
    });

    test('shows "In memory — not saved" badge in status bar', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await expect(page.locator('.status-memory-badge')).toBeVisible();
        await expect(page.locator('.status-memory-badge')).toContainText('In memory');
    });

    test('falls back to Memory without changing encrypted data when compression APIs are missing', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vmd_last_mode', 'local');
            localStorage.setItem('vmd_data_enc', 'test-salt|test-ciphertext');
            Object.defineProperty(window, 'CompressionStream', { configurable: true, value: undefined });
            Object.defineProperty(window, 'DecompressionStream', { configurable: true, value: undefined });
        });
        await page.goto('/');

        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await expect(page.locator('.status-memory-badge')).toContainText('In memory');
        await expect(page.getByRole('alert')).toContainText('Encrypted Local and Remote storage are unavailable');
        await expect(page.getByRole('button', { name: /Enable Secure Storage/ })).not.toBeVisible();
        await expect.poll(() => page.evaluate(() => localStorage.getItem('vmd_last_mode'))).toBe('local');
        await expect.poll(() => page.evaluate(() => localStorage.getItem('vmd_data_enc')))
            .toBe('test-salt|test-ciphertext');
    });

    test('hides Raw button in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        // Raw button should not be visible in memory mode
        await expect(page.getByRole('button', { name: 'Raw' })).not.toBeVisible();
    });

    test('Options hides Upgrade storage and Delete local data in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await page.getByRole('button', { name: 'Options' }).click();
        await expect(page.getByRole('button', { name: /Upgrade storage/i })).not.toBeVisible();
        await expect(page.getByRole('button', { name: 'Delete local data' })).not.toBeVisible();
    });

    test('Options shows app version', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        const expectedVersion = await page.locator('meta[name="app-version"]').getAttribute('content');
        expect(expectedVersion).toBeTruthy();

        await page.getByRole('button', { name: 'Options' }).click();
        await expect(page.locator('[data-app-version]')).toHaveText(expectedVersion || '');

        // The GitHub link sits to the right of the version with a visible gap.
        const versionBox = (await page.locator('[data-app-version]').boundingBox())!;
        const linkBox = (await page.getByRole('link', { name: /See on GitHub/ }).boundingBox())!;
        expect(linkBox.x - (versionBox.x + versionBox.width)).toBeGreaterThanOrEqual(8);
    });

    test('Enable Secure Storage banner opens the lock screen', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        // Upgrade storage now lives in the persistent banner shown while in memory mode
        await page.getByRole('button', { name: /Enable Secure Storage/ }).click();

        await expect(page.getByText('Unlock Virgulas')).toBeVisible({ timeout: 3000 });
    });

    test('Enable Secure Storage banner sits above the breadcrumb', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        // Zoom into a node so the breadcrumb strip renders.
        await page.locator('.node-content').first().locator('.bullet').click();
        await expect(page.locator('.breadcrumbs')).toBeVisible();

        const banner = page.getByRole('button', { name: /Enable Secure Storage/ });
        await expect(banner).toBeVisible();
        const bannerBox = (await banner.boundingBox())!;
        const crumbBox = (await page.locator('.breadcrumbs').boundingBox())!;
        expect(bannerBox.y).toBeLessThan(crumbBox.y);
    });

    test('document is not persisted between visits in memory mode', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

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
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
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
        // Load in memory mode (no localStorage) and remember a node ID.
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        const nodeId = await page.locator('.node-content').first().getAttribute('data-node-id');
        expect(nodeId).toBeTruthy();

        // A genuine first load: the document is re-parsed from INTRO.VMD, so the
        // node ID only survives if VMD parsing derives stable IDs.
        await page.goto('about:blank');
        await page.goto(`/#${nodeId}`);
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        // Breadcrumbs should be visible because we are now zoomed into that node.
        await expect(page.locator('.breadcrumbs')).toBeVisible({ timeout: 3000 });
    });
});
