import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Service worker offline shell', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'Service worker assertions are run in Chromium only to keep CI deterministic.');

    test('offline navigation serves cached app shell and boots the local document', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'offline-1', text: 'Offline Node', children: [] }
            ]
        });

        await page.evaluate(async () => {
            await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
        });

        await expect.poll(
            async () => page.evaluate(async () => !!navigator.serviceWorker.controller),
            { timeout: 10000 }
        ).toBe(true);

        await expect.poll(
            async () => page.evaluate(async () => {
                const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
                if (!appCacheName) return false;
                const appCache = await caches.open(appCacheName);
                const shell = await appCache.match('./index.html');
                const appEntry = await appCache.match('./js/app.js');
                return !!shell && !!appEntry;
            }),
            { timeout: 10000 }
        ).toBe(true);

        await page.context().setOffline(true);
        await page.reload({ waitUntil: 'domcontentloaded' });

        await expect(page.locator('#auth-passphrase')).toBeVisible();
        await page.locator('#auth-passphrase').fill('password');
        await page.getByRole('button', { name: 'Unlock' }).click();

        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await expect(page.locator('.node-text-md').first()).toContainText('Offline Node');

        await page.context().setOffline(false);
    });
});