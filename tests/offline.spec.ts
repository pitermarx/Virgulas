import { test, expect, setupDoc, type Page } from './test';

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
                const cssEntry = await appCache.match('./js/app.css');
                return !!shell && !!appEntry && !!cssEntry;
            }),
            { timeout: 10000 }
        ).toBe(true);

        await page.goto('/');
        await expect(page.locator('#auth-passphrase')).toBeVisible({ timeout: 15000 });

        // navigate to the local document (served from Memory)
        await page.goto('/');
        await expect.poll(
            async () => page.evaluate(() => document.querySelector('#root')?.textContent),
            { timeout: 10000 }
        ).toBe('Root');

        // navigation handler must cache the app shell once, under ./index.html,
        // and never under this URL (sec-03). page.goto resolves only after the
        // service worker has had a chance to intercept and cache the response.
        await page.goto('/?quick-add=SECRETCAPTURETOKEN123');
        await expect.poll(
            async () => page.evaluate(async () => {
                const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
                if (!appCacheName) return false;
                const appCache = await caches.open(appCacheName);
                return !!(await appCache.match('./index.html'));
            }),
            { timeout: 10000 }
        ).toBe(true);
        await expect.poll(
            async () => page.evaluate(async () => {
                const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
                if (!appCacheName) return false;
                const appCache = await caches.open(appCacheName);
                return !(await appCache.match('/?quick-add=SECRETCAPTURETOKEN123'));
            }),
            { timeout: 10000 }
        ).toBe(true);

        // purge local data and clear service worker caches
        const mod = await import('/js/app.js' as string) as { persistence: { clearLocalData(): void } };
        await mod.persistence.clearLocalData();
        await expect.poll(virgulasCacheCount, { timeout: 10000 }).toBe(0);

        // re-enable service worker and go online again
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        // after reload, the shell should be cached from the fetch handler (network-first)
        await expect.poll(async () => readCachedShell(page), { timeout: 10000 }).not.toBeNull();

        // The Options → Privacy link is target="_blank" to /privacy.html, a real
        // same-origin navigation. It must be served but never cached under the
        // same key as the app shell.
        await page.goto('/privacy.html');
        await expect.poll(
            async () => page.evaluate(async () => {
                const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
                if (!appCacheName) return false;
                const appCache = await caches.open(appCacheName);
                return !!(await appCache.match('./index.html'));
            }),
            { timeout: 10000 }
        ).toBe(true);
        expect(await readCachedShell(page)).toContain('<title>Virgulas</title>');

    test('a 404 navigation does not become the offline shell', async ({ page }) => {
        await setupDoc(page, { id: 'root', text: 'Root', children: [] });
        await startServiceWorker(page);

        await page.goto('/');
        await expect.poll(async () => readCachedShell(page), { timeout: 10000 }).not.toBeNull();

        // serve-bun answers unknown paths with a real 404 ("Not found"). The
        // navigation handler must not pin it as ./index.html.
        await page.goto('/definitely-not-a-real-page');
        await expect.poll(
            async () => page.evaluate(() => document.body.innerText),
            { timeout: 10000 }
        ).toMatch(/not found/i);

        const shell = await readCachedShell(page);
        expect(shell).toContain('<title>Virgulas</title>');
        expect(shell).not.toContain('Not found');
    });

    test('same-origin requests outside the allowlist pass through uncached', async ({ page }) => {
        await setupDoc(page, { id: 'root', text: 'Root', children: [] });
        await startServiceWorker(page);

        await page.goto('/');
        await expect.poll(async () => readCachedShell(page), { timeout: 10000 }).not.toBeNull();

        // llms.txt is a same-origin GET but not part of the app shell, fonts,
        // chunk, or tour. It must pass straight through (never enter Cache
        // Storage), replacing the old stale-while-revalidate catch-all.
        await page.evaluate(async () => {
            const response = await fetch('/llms.txt');
            if (!response.ok) throw new Error(`expected llms.txt, got ${response.status}`);
        });

        const cached = await page.evaluate(async () => {
            const names = await caches.keys();
            for (const name of names) {
                const cache = await caches.open(name);
                const requests = await cache.keys();
                if (requests.some((req) => req.url.includes('llms.txt'))) return true;
            }
            return false;
        });
        expect(cached).toBe(false);
    });
});

async function startServiceWorker(page: Page) {
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
    });

    await expect.poll(
        async () => page.evaluate(async () => !!navigator.serviceWorker.controller),
        { timeout: 10000 }
    ).toBe(true);
}

async function readCachedShell(page: Page): Promise<string | null> {
    return page.evaluate(async () => {
        const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
        if (!appCacheName) return null;
        const appCache = await caches.open(appCacheName);
        const response = await appCache.match('./index.html');
        if (!response) return null;
        return await response.text();
    });
}

async function virgulasCacheCount(): Promise<number> {
    return await page.evaluate(async () => {
        const names = await caches.keys();
        let count = 0;
        for (const name of names) {
            if (name.startsWith('virgulas-')) {
                const cache = await caches.open(name);
                const requests = await cache.keys();
                count += requests.length;
            }
        }
        return count;
    });
}
