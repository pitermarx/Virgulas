import { setupDoc, submitUnlock, test, expect } from '../test';

// Follows https://specification.website. Covers the served behaviour of the
// artifacts added for the crawl/discovery/security/a11y required tier.

test.describe('Website Specification — crawl and discovery files', () => {
    test('robots.txt declares a policy, Content-Signal and sitemap', async ({ request }) => {
        const response = await request.get('/robots.txt');
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(body).toMatch(/^User-Agent:\s*\*/m);
        expect(body).toMatch(/^Allow:\s*\//m);
        expect(body).toMatch(/^Content-Signal:/m);
        expect(body).toMatch(/^Sitemap:\s*https:\/\/virgulas\.com\/sitemap\.xml$/m);
    });

    test('sitemap.xml lists the canonical home URL', async ({ request }) => {
        const response = await request.get('/sitemap.xml');
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(body).toContain('<loc>https://virgulas.com/</loc>');
    });

    test('llms.txt and the well-known files are served', async ({ request }) => {
        expect((await request.get('/llms.txt')).status()).toBe(200);

        const security = await request.get('/.well-known/security.txt');
        expect(security.status()).toBe(200);
        expect(await security.text()).toMatch(/^Contact:/m);

        const gpc = await request.get('/.well-known/gpc.json');
        expect(gpc.status()).toBe(200);
        expect((await gpc.json()).gpc).toBe(true);
    });

    test('a root favicon and the privacy page are available', async ({ request }) => {
        expect((await request.get('/favicon.ico')).status()).toBe(200);
        expect((await request.get('/favicon.svg')).status()).toBe(200);

        const privacy = await request.get('/privacy.html');
        expect(privacy.status()).toBe(200);
        const body = await privacy.text();
        expect(body).toMatch(/<h1[^>]*>[\s\S]*Privacy[\s\S]*<\/h1>/);
    });

    test('the custom 404 page is available and self-contained', async ({ request }) => {
        const response = await request.get('/404.html');
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(body).toContain('404');
        expect(body).toContain('href="/"');
    });
});

test.describe('Website Specification — document foundations', () => {
    test('the served head carries canonical, Open Graph, theme-colour and JSON-LD', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://virgulas.com/');
        await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Virgulas');
        await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light dark');
        expect(await page.locator('meta[name="theme-color"]').count()).toBe(2);

        const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
        const data = JSON.parse(jsonLd!);
        expect(data['@type']).toBe('SoftwareApplication');
        expect(data.name).toBe('Virgulas');
    });

    test('the Options footer links the privacy policy', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        await page.getByRole('button', { name: 'Options' }).click();
        const link = page.getByRole('link', { name: 'Privacy' });
        await expect(link).toHaveAttribute('href', '/privacy.html');
    });
});

test.describe('Website Specification — accessibility contract', () => {
    test('the skip link is the first focusable element and targets main', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        await page.keyboard.press('Tab');
        await expect(page.locator('.skip-link')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('#main-content')).toBeFocused();
    });

    test('the shell exposes one h1, a main and a contentinfo landmark', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        await expect(page.locator('h1')).toHaveCount(1);
        await expect(page.locator('main#main-content')).toHaveCount(1);
        await expect(page.locator('[role="contentinfo"]')).toHaveCount(1);
    });

    test('a failed unlock announces the error and marks the input invalid', async ({ page }) => {
        // Create the local document through the UI instead of seeding ciphertext
        // via the e2e seam, which ships empty in production — this keeps the test
        // runnable in daily.yml against virgulas.com.
        // One-shot via sessionStorage: on this test's reload the script must not
        // run again, or it would wipe the document created below and put the
        // sheet back on the create-passphrase step (where the “wrong” passphrase
        // would simply create a new document and unlock successfully).
        await page.addInitScript(() => {
            if (sessionStorage.getItem('vmd-spec-seed')) return;
            sessionStorage.setItem('vmd-spec-seed', '1');
            localStorage.clear();
            localStorage.setItem('vmd_last_mode', 'local');
        });
        await page.goto('/');

        await page.getByLabel('Create a passphrase').fill('right-passphrase');
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

        // Autosave is debounced: wait for the encrypted payload to persist
        // before reloading, or the lock screen would re-open the create step.
        await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_data_enc')))
          .not.toBeNull();

        // Reload back to the lock screen and submit a wrong passphrase.
        await page.reload();
        await submitUnlock(page, 'wrong-passphrase');

        const error = page.locator('#auth-unlock-error');
        await expect(error).toBeVisible();
        await expect(error).toHaveAttribute('role', 'alert');
        await expect(page.locator('#auth-passphrase')).toHaveAttribute('aria-invalid', 'true');
    });
});
