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

/**
 * A capture URL is untrusted input (sec-01): it only pre-fills the prompt, so a
 * spec that wants the entry queued must confirm it the way a user would.
 */
async function confirmCapture(page: import('@playwright/test').Page) {
  await expect(page.locator('#quick-capture-input')).toBeVisible();
  // The submit button is labelled "Add to <inbox node name>", so match the
  // prefix rather than the default name.
  await page.getByRole('button', { name: /^Add to / }).click();
  await expect(page.locator('#quick-capture-input')).toHaveCount(0);
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
        url: '/?quick-capture=1',
        icons: expect.arrayContaining([
          expect.objectContaining({ src: '/media/quick-capture-96x96.png', sizes: '96x96', type: 'image/png' }),
          expect.objectContaining({ src: '/media/quick-capture-192x192.png', sizes: '192x192', type: 'image/png' })
        ])
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

  test('direct quick-add is queued after confirmation and reconciled after unlock', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    // sec-01: a capture visit never boots the app, and the URL alone writes
    // nothing — the user has to confirm it first.
    await page.goto('/?quick-add=buy%20milk');
    expect(await page.evaluate(() => localStorage.getItem('vmd_inbox_queue'))).toBeNull();
    expect(new URL(page.url()).search).toBe('');

    await confirmCapture(page);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('buy milk');

    // The next real visit unlocks and files the queued capture.
    await page.goto('/');
    await unlockApp(page);

    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Inbox', 'buy milk']);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toBeNull();
  });

  test('share-target text is captured as a markdown link with the selection as its description', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.goto('/?title=Buy%20milk&text=Remember%20to%20buy%20milk&url=https%3A%2F%2Fexample.com');
    await confirmCapture(page);

    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('Remember to buy milk');

    await page.goto('/');
    await unlockApp(page);

    // Assert through what rendered: the captured title shows as a markdown
    // link and the selection text as the node's rendered description.
    const link = page.locator('.node-text-md a[href="https://example.com"]');
    await expect.poll(async () => link.count()).toBe(1);
    await expect(link).toHaveText('Buy milk');

    const entryNode = link.locator('xpath=ancestor::div[contains(@class,"node-content")]');
    await expect(entryNode.locator('.node-desc-md')).toHaveText('Remember to buy milk');
  });

  test('quick capture shortcut opens a prompt that can be used while locked', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.goto('/?quick-capture=1');
    const captureInput = page.locator('#quick-capture-input');
    await expect(captureInput).toBeVisible();
    await expect(page.locator('#auth-passphrase')).toHaveCount(0);

    await captureInput.fill('from shortcut');
    await page.getByRole('button', { name: 'Add to Inbox' }).click();
    await expect(captureInput).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('from shortcut');

    // Still locked: the capture is filed on the next real unlock.
    await page.goto('/');
    await unlockApp(page);
    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Inbox', 'from shortcut']);
  });

  test('quick-add pre-fills the prompt when the app is already unlocked', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('quick-add', 'already unlocked');
      window.history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // sec-01 applies to a share that arrives while the app runs too: the URL is
    // still untrusted input, so it only pre-fills. Nothing is written until the
    // user confirms.
    const captureInput = page.locator('#quick-capture-input');
    await expect(captureInput).toBeVisible();
    await expect(captureInput).toHaveValue('already unlocked');
    await expect.poll(() => visibleNodeTexts(page)).not.toContain('already unlocked');
    expect(new URL(page.url()).search).toBe('');

    await confirmCapture(page);

    // Confirmed while unlocked: it files straight into the Inbox node.
    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Inbox', 'already unlocked']);
  });

  test('uses a configured Inbox node name for future captures', async ({ page }) => {
    await setupEmptyLocalDoc(page);

    await page.getByRole('button', { name: 'Options' }).click();
    const options = page.getByRole('dialog', { name: 'Options' });
    const inboxNameField = options.locator('#admin-inbox-node-name');
    // Type the new name instead of using fill(). Firefox only emits `change`
    // (which is what Preact's onChange listens for) on blur when the value was
    // changed by real user input, so a programmatic fill() intermittently
    // skips the commit and the rename is silently lost.
    await inboxNameField.click();
    await inboxNameField.selectText();
    await inboxNameField.pressSequentially('Captured');
    await inboxNameField.press('Tab');
    // The rename is only committed on blur; wait for the write to land before
    // navigating away so a slow commit cannot surface as a confusing failure
    // much later, when the queued capture reconciles into the default "Inbox".
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_node_name')))
      .toBe('Captured');
    await options.getByRole('button', { name: 'Close' }).click();

    await page.goto('/?quick-add=custom%20name');
    // Capture only: the queue is written after confirmation and nothing is
    // unlocked. This device has local data, so the handover lands on the local
    // unlock screen — the entry survives there for the next real unlock.
    await confirmCapture(page);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('custom name');
    await expect(page.locator('#auth-passphrase')).toBeVisible();

    await page.goto('/');
    await unlockApp(page);
    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Captured', 'custom name']);
  });
});
