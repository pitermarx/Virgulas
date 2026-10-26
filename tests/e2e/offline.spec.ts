import { test, expect, setupDoc, type Page } from '../test';

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

        // Purge through the actual Options → "Delete local data" UI path.
        await purgeViaOptions(page);

        // clearAppCaches runs best-effort; poll until every virgulas cache is gone.
        await expect.poll(virgulasCacheCount, { timeout: 10000 }).toBe(0);
    });

    test('a full purge leaves no user data in localStorage (priv-01)', async ({ page }) => {
        await setupDoc(page, { id: 'root', text: 'Root', children: [] });

        // Seed the plaintext residue slots that a purge must not leave behind:
        // the quick-capture queue holds captured page text, the rest is sync and
        // session metadata. Theme is a device preference and must survive.
        await page.evaluate(() => {
            localStorage.setItem('vmd_sync_ts', '12345');
            localStorage.setItem('vmd_inbox_node_name', 'Capture');
            localStorage.setItem('vmd_scheduled_window', '7');
            localStorage.setItem('vmd_inbox_queue', JSON.stringify([{ id: 'a', text: 'captured secret' }]));
            localStorage.setItem('vmd_theme', 'dark');
        });

        // Purge through the actual Options → "Delete local data" UI path.
        await purgeViaOptions(page);

        const state = await page.evaluate(() => ({
            residual: ['vmd_sync_ts', 'vmd_sync_head', 'vmd_inbox_node_name', 'vmd_scheduled_window', 'vmd_inbox_queue']
                .filter((key) => localStorage.getItem(key) !== null),
            theme: localStorage.getItem('vmd_theme'),
        }));
        expect(state.residual).toEqual([]);
        expect(state.theme).toBe('dark');
    });

    // Runs the purging UI path: Options → "Delete local data", accepting the
    // confirm dialog. This drives the same code the user triggers instead of
    // reaching into the persistence module through the e2e seam.
    async function purgeViaOptions(page: Page) {
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Options' }).click();
        await page.getByRole('button', { name: 'Delete local data' }).click();
        // The purge finishes by booting memory mode.
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    }

    // Registers the service worker and waits until it controls the page, so the
    // fetch handler is guaranteed to intercept the navigations below.
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

    // Returns the text currently cached under the canonical shell key.
    function readCachedShell(page: Page) {
        return page.evaluate(async () => {
            const appCacheName = (await caches.keys()).find((key) => key.startsWith('virgulas-app-v'));
            if (!appCacheName) return null;
            const cache = await caches.open(appCacheName);
            const response = await cache.match('./index.html');
            return response ? await response.text() : null;
        });
    }

    test('a non-shell navigation (privacy page) does not overwrite the cached shell', async ({ page }) => {
        await setupDoc(page, { id: 'root', text: 'Root', children: [] });
        await startServiceWorker(page);

        // Establish the shell under the canonical key.
        await page.goto('/');
        await expect.poll(async () => readCachedShell(page), { timeout: 10000 }).not.toBeNull();

        // The Options → Privacy link is target="_blank" to /privacy.html, a real
        // same-origin navigation. It must be served but never cached under the
        // shell key, or offline the app would boot into the privacy page.
        await page.goto('/privacy.html');
        await expect.poll(
            async () => page.evaluate(() => document.title),
            { timeout: 10000 }
        ).toContain('Privacy');

        const shell = await readCachedShell(page);
        expect(shell).toContain('<title>Virgulas</title>');
        expect(shell).not.toContain('<title>Privacy');
    });

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