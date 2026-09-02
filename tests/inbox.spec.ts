import { test, expect } from './test';
import { setupDoc, unlockApp } from './test';

async function visibleNodeTexts(page: import('@playwright/test').Page) {
  return page.locator('.node-content').evaluateAll(nodes => nodes.map(node => {
    const text = node.querySelector('.node-text-md');
    return text?.textContent?.trim() || '';
  }));
}

async function setupEmptyLocalDoc(page: import('@playwright/test').Page) {
  await setupDoc(page, {
    id: 'root',
    text: 'Root',
    children: []
  });
}

test.describe('Quick capture inbox', () => {
  test('manifest exposes the PWA shortcut and GET share target', async ({ request }) => {
    const response = await request.get('/site.webmanifest');
    expect(response.ok()).toBeTruthy();
    const manifest = await response.json();

    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.shortcuts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Quick capture',
        url: '/?quick-capture=1'
      })
    ]));
    expect(manifest.share_target).toEqual({
      action: '/',
      method: 'GET',
      params: {
        title: 'title',
        text: 'text',
        url: 'url'
      }
    });
  });

  test('direct quick-add is queued while locked and reconciled after unlock', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.goto('/?quick-add=buy%20milk');
    await expect(page.locator('#auth-passphrase')).toBeVisible();
    await unlockApp(page);

    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Inbox', 'buy milk']);
    expect(new URL(page.url()).search).toBe('');
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toBeNull();
  });

  test('share-target text is captured with shared URL content', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.goto('/?title=Buy%20milk&text=Remember%20to%20buy%20milk&url=https%3A%2F%2Fexample.com');
    await unlockApp(page);

    await expect.poll(() => visibleNodeTexts(page)).toEqual([
      'Inbox',
      'Buy milk\nRemember to buy milk\nhttps://example.com'
    ]);
  });

  test('quick capture shortcut opens a prompt that can be used while locked', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.goto('/?quick-capture=1');
    const captureInput = page.locator('#quick-capture-input');
    await expect(captureInput).toBeVisible();
    await captureInput.fill('from shortcut');
    await page.getByRole('button', { name: 'Add to Inbox' }).click();
    await expect(captureInput).toHaveCount(0);

    await unlockApp(page);
    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Inbox', 'from shortcut']);
  });

  test('quick-add reconciles immediately when the app is already unlocked', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('quick-add', 'already unlocked');
      window.history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Inbox', 'already unlocked']);
    expect(new URL(page.url()).search).toBe('');
  });

  test('uses a configured Inbox node name for future captures', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.getByRole('button', { name: 'Options' }).click();
    const options = page.getByRole('dialog', { name: 'Options' });
    await options.locator('#admin-inbox-node-name').fill('Captured');
    await options.locator('#admin-inbox-node-name').press('Tab');
    await options.getByRole('button', { name: 'Close' }).click();

    await page.goto('/?quick-add=custom%20name');
    await unlockApp(page);
    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Captured', 'custom name']);
  });
});
