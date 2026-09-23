import { test, expect, type Page, setupDoc } from './test';

/** Record auto-close attempts instead of letting the browser decide. */
const stubWindowClose = (page: Page) =>
  page.addInitScript(() => {
    (window as any).__closeAttempts = 0;
    window.close = () => { (window as any).__closeAttempts += 1; };
  });

/** Count WebAuthn prompting so a capture visit can be proven not to ask. */
const trackWebAuthn = (page: Page) =>
  page.addInitScript(() => {
    (window as any).__webAuthnRequests = 0;
    const credentials = navigator.credentials;
    if (credentials?.get) {
      const original = credentials.get.bind(credentials);
      credentials.get = ((...args: any[]) => {
        (window as any).__webAuthnRequests += 1;
        return original(...args);
      }) as typeof credentials.get;
    }
  });

const queueRaw = (page: Page) => page.evaluate(() => localStorage.getItem('vmd_inbox_queue'));
const queueLength = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('vmd_inbox_queue') || '[]').length);
const queueEntries = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('vmd_inbox_queue') || '[]') as Array<{ text: string; description: string }>
  );

test.describe('Quick capture fast path', () => {
  test('a direct capture stays locked and never boots or prompts for biometrics', async ({ page }) => {
    await stubWindowClose(page);
    await trackWebAuthn(page);

    await page.goto('/?quick-add=buy%20milk');

    // Queued, and the capture parameters were consumed.
    await expect.poll(() => queueRaw(page)).toContain('buy milk');
    expect(new URL(page.url()).search).toBe('');

    // The app was never booted: no lock screen, no shell, no rendered view.
    await expect(page.locator('#auth-passphrase')).toHaveCount(0);
    await expect(page.locator('#app .app-shell')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveAttribute('data-main-view', 'rendered');

    // No WebAuthn prompt was attempted.
    expect(await page.evaluate(() => (window as any).__webAuthnRequests)).toBe(0);

    // The window was asked to close (it is a script-opened popup in real use).
    expect(await page.evaluate(() => (window as any).__closeAttempts)).toBe(1);
  });

  test('a minimal confirmation is shown when the window cannot close itself', async ({ page }) => {
    await stubWindowClose(page);

    await page.goto('/?quick-add=remember%20this');

    await expect(page.locator('.capture-only-card')).toBeVisible();
    await expect(page.locator('.capture-only-title')).toHaveText('Saved to the Inbox queue');
    await expect(page.getByRole('link', { name: 'Open Virgulas' })).toBeVisible();
  });

  test('an empty quick-add opens the prompt while staying locked', async ({ page }) => {
    await stubWindowClose(page);

    await page.goto('/?quick-add=');

    const captureInput = page.locator('#quick-capture-input');
    await expect(captureInput).toBeVisible();
    await expect(page.locator('#auth-passphrase')).toHaveCount(0);

    await captureInput.fill('typed while locked');
    await page.getByRole('button', { name: 'Add to Inbox' }).click();

    await expect.poll(() => queueRaw(page)).toContain('typed while locked');
    await expect(captureInput).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__closeAttempts)).toBe(1);
  });

  test('a captured page becomes a markdown link with the selection as its description', async ({ page }) => {
    await stubWindowClose(page);

    await page.goto('/?title=Readable%20page&text=A%20useful%20quote&url=https%3A%2F%2Fexample.com%2Fpage');

    await expect.poll(() => queueLength(page)).toBe(1);
    const [entry] = await queueEntries(page);
    expect(entry.text).toBe('[Readable page](https://example.com/page)');
    expect(entry.description).toBe('A useful quote');
    await expect(page.locator('#auth-passphrase')).toHaveCount(0);
  });

  test('share-target parameters queue directly and de-duplicate the URL', async ({ page }) => {
    await stubWindowClose(page);

    await page.goto('/?title=Example&text=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.com');

    await expect.poll(() => queueLength(page)).toBe(1);
    const [entry] = await queueEntries(page);
    expect(entry.text).toBe('[Example](https://example.com)');
    expect(entry.description).toBe('');
    await expect(page.locator('#auth-passphrase')).toHaveCount(0);
  });

  test('a consumed capture URL does not queue again on reload', async ({ page }) => {
    await stubWindowClose(page);

    await page.goto('/?quick-add=once');
    await expect.poll(() => queueLength(page)).toBe(1);

    // The capture parameters were stripped, so the reload is a normal visit.
    await page.reload();
    await expect(page.locator('.capture-only')).toHaveCount(0);
    expect(await queueLength(page)).toBe(1);
  });

  test('options explains how to capture and offers a bookmarklet', async ({ page }) => {
    await setupDoc(page, { id: 'root', text: 'Root', children: [] });

    await page.getByRole('button', { name: 'Options' }).click();

    await expect(page.getByRole('heading', { name: 'Quick capture' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ways to capture' })).toBeVisible();
    await expect(page.getByText('long-press the icon')).toBeVisible();
    await expect(page.getByText('/?quick-add=your%20text')).toBeVisible();

    const bookmarklet = page.getByRole('link', { name: 'Save to', exact: true });
    await expect(bookmarklet).toHaveAttribute('href', /^javascript:/);
    await expect(bookmarklet).toHaveAttribute('draggable', 'true');
    await expect(page.getByRole('button', { name: 'Copy bookmarklet' })).toHaveCount(0);
    await expect(page.getByText('Bookmarklet:')).toBeVisible();

    // The button replaces the old "Inbox node" label and sits inline with the
    // destination text box, which keeps its accessible name.
    await expect(page.getByText('Inbox node', { exact: true })).toHaveCount(0);
    const input = page.getByLabel('Inbox node name');
    await expect(input).toHaveValue('Inbox');

    const buttonBox = (await bookmarklet.boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    const buttonMid = buttonBox.y + buttonBox.height / 2;
    const inputMid = inputBox.y + inputBox.height / 2;
    expect(Math.abs(buttonMid - inputMid)).toBeLessThan(8);
  });

  test('clicking the Save to button copies the bookmarklet to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupDoc(page, { id: 'root', text: 'Root', children: [] });

    await page.getByRole('button', { name: 'Options' }).click();
    const bookmarklet = page.getByRole('link', { name: 'Save to', exact: true });

    await bookmarklet.click();
    await expect(page.getByText('Bookmarklet copied')).toBeVisible();

    const href = await bookmarklet.getAttribute('href');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(href);
  });
});
