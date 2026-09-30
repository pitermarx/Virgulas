import { test, expect } from './test';

test.describe('No-JavaScript fallback', () => {
    test.use({ javaScriptEnabled: false });

    test('shows an actionable message instead of a stuck splash', async ({ page }) => {
        await page.goto('/');

        // The static splash would otherwise stay on screen forever without JS.
        await expect(page.locator('#splash')).toBeHidden();
        await expect(page.locator('.noscript-fallback')).toBeVisible();
        await expect(page.getByRole('heading', { name: /Virgulas needs JavaScript/i })).toBeVisible();
        await expect(page.getByText(/Enable JavaScript in your browser settings/i)).toBeVisible();
    });
});
