import { test, expect } from './test';
import { setupDoc, unlockApp } from './test';

async function visibleNodeTexts(page: import('@playwright/test').Page) {
  return page.locator('.node-content').evaluateAll(nodes => nodes.map(node => {
    const text = node.querySelector('.node-text-md');
    return text?.textContent?.trim() || '';
  }));
}

/** Children of the Inbox node as stored in the model (raw markdown, not rendered). */
async function inboxNodeEntries(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const { outline } = await (window as any).__appModule();
    const root = outline.get('root')!;
    const inboxId = root.children.peek().find((id: string) => outline.get(id)!.text.peek() === 'Inbox');
    if (!inboxId) return [];
    return outline.get(inboxId)!.children.peek().map((id: string) => ({
      text: outline.get(id)!.text.peek(),
      description: outline.get(id)!.description.peek()
    }));
  });
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

    // A capture visit never boots the app: it stays locked and writes the queue.
    await page.goto('/?quick-add=buy%20milk');
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('buy milk');
    expect(new URL(page.url()).search).toBe('');

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
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('Remember to buy milk');

    await page.goto('/');
    await unlockApp(page);

    await expect.poll(() => inboxNodeEntries(page)).toEqual([
      { text: '[Buy milk](https://example.com)', description: 'Remember to buy milk' }
    ]);
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
    // Capture only: the queue is written and nothing is unlocked.
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('vmd_inbox_queue')))
      .toContain('custom name');

    await page.goto('/');
    await unlockApp(page);
    await expect.poll(() => visibleNodeTexts(page)).toEqual(['Captured', 'custom name']);
  });
});
