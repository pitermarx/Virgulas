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
        await page.reload({ waitUntil: 'networkidle' });

        await expect(page.locator('#auth-passphrase')).toBeVisible({ timeout: 15000 });
        await page.locator('#auth-passphrase').fill('password');
        await page.getByRole('button', { name: 'Unlock' }).click();

        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
        await expect(page.locator('.node-text-md').first()).toContainText('Offline Node');

        await page.context().setOffline(false);
    });

    test('quick-capture navigation does not write the capture URL into Cache Storage', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: []
        });

        await page.evaluate(async () => {
            await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
        });

        await expect.poll(
            async () => page.evaluate(async () => !!navigator.serviceWorker.controller),
            { timeout: 10000 }
        ).toBe(true);

        // A quick-capture URL carries the captured text in the query string. The
        // navigation handler must cache the app shell once, under ./index.html,
        // and never under this URL (sec-03). page.goto resolves only after the
        // service worker has processed the navigation, so any URL-keyed entry
        // written by a regression would already exist here.
        await page.goto('/?quick-add=SECRETCAPTURETOKEN123');

        await expect.poll(
            async () => page.evaluate(async () => {
                const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
                if (!appCacheName) return false;
                const cache = await caches.open(appCacheName);
                return !!(await cache.match('./index.html'));
            }),
            { timeout: 10000 }
        ).toBe(true);

        const leaked = await page.evaluate(async () => {
            const names = await caches.keys();
            for (const name of names) {
                const cache = await caches.open(name);
                const requests = await cache.keys();
                if (requests.some((req) => req.url.includes('SECRETCAPTURETOKEN123'))) return true;
            }
            return false;
        });
        expect(leaked).toBe(false);
    });

    test('purging local data clears the service worker caches', async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: []
        });

        await page.evaluate(async () => {
            await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
        });

        await expect.poll(
            async () => page.evaluate(async () => {
                const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
                if (!appCacheName) return false;
                const cache = await caches.open(appCacheName);
                return !!(await cache.match('./index.html'));
            }),
            { timeout: 10000 }
        ).toBe(true);

        const virgulasCacheCount = () =>
            page.evaluate(async () => (await caches.keys()).filter((key) => key.startsWith('virgulas-')).length);

        // The offline shell and fonts caches exist before the purge.
        expect(await virgulasCacheCount()).toBeGreaterThan(0);

        // Purge through the running app singleton, exactly as the Options →
        // "Delete local data" and mode-switch paths do.
        await page.evaluate(async () => {
            const mod = await import('/js/app.js' as string) as { persistence: { clearLocalData(): void } };
            mod.persistence.clearLocalData();
        });

        // clearAppCaches runs best-effort; poll until every virgulas cache is gone.
        await expect.poll(virgulasCacheCount, { timeout: 10000 }).toBe(0);
    });
});