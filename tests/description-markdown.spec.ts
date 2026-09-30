import { test, expect } from './test';
import { setupDoc } from './test';

// Block-level markdown in a node "Description": the two-line preview stays a
// compact inline preview, but the zoomed description reads as a normal markdown
// document (headings, lists, quotes, fenced code, rules, tables, images).

const RICH_DESCRIPTION = [
  '## Heading two',
  '',
  'A paragraph with **bold** and `code` and [a link](https://example.com).',
  '',
  '1. first item',
  '2. second item',
  '',
  '> A quoted passage.',
  '',
  '---',
  '',
  '```',
  'const x = 1',
  '```',
  '',
  '| Col A | Col B |',
  '| --- | --- |',
  '| one | two |'
].join('\n');

function docWithDescription(description: string, extra: Record<string, any> = {}) {
  return {
    id: 'root',
    text: 'Root',
    children: [{
      id: '1',
      text: 'Parent',
      description,
      children: [{ id: '1.1', text: 'Child', children: [] }],
      ...extra
    }]
  };
}

async function zoomIntoParent(page: import('@playwright/test').Page) {
  await page.locator('[data-node-id="1"] .node-text-md').click();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.zoom-desc-display')).toBeVisible();
}

test.describe('Description markdown', () => {
  test('the zoomed description renders as a full markdown document', async ({ page }) => {
    await setupDoc(page, docWithDescription(RICH_DESCRIPTION));
    await zoomIntoParent(page);

    const display = page.locator('.zoom-desc-display');
    await expect(display.locator('h2')).toHaveText('Heading two');
    await expect(display.locator('p').first()).toContainText('A paragraph with');
    await expect(display.locator('strong')).toHaveText('bold');
    await expect(display.locator('code', { hasText: 'code' })).toBeVisible();
    await expect(display.locator('a[href="https://example.com"]')).toBeVisible();
    await expect(display.locator('ol li')).toHaveCount(2);
    await expect(display.locator('blockquote')).toContainText('A quoted passage.');
    await expect(display.locator('hr')).toHaveCount(1);
    await expect(display.locator('pre code')).toContainText('const x = 1');
    await expect(display.locator('table th')).toHaveCount(2);
    await expect(display.locator('table td')).toHaveCount(2);
  });

  test('block markdown never carries a language class on code blocks', async ({ page }) => {
    await setupDoc(page, docWithDescription('```js\nconst x = 1\n```'));
    await zoomIntoParent(page);

    const code = page.locator('.zoom-desc-display pre code');
    await expect(code).toHaveText('const x = 1');
    expect(await code.getAttribute('class')).toBeNull();
  });

  test('the non-zoomed description stays a two-line inline preview', async ({ page }) => {
    await setupDoc(page, docWithDescription(RICH_DESCRIPTION));

    const preview = page.locator('[data-node-id="1"] .node-desc-md');
    await expect(preview).toBeVisible();
    // Block elements are only introduced by the zoomed (block) renderer.
    await expect(preview.locator('h2')).toHaveCount(0);
    await expect(preview.locator('pre')).toHaveCount(0);
    await expect(preview.locator('table')).toHaveCount(0);

    // CSS line-clamp clips visually; content stays in the DOM.
    const clipped = await preview.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(clipped).toBe(true);
  });

  test('the zoomed description cannot inject app chrome, forms, or scripts', async ({ page }) => {
    await setupDoc(page, docWithDescription(
      '<div class="modal-overlay" id="app" style="position:fixed;inset:0">spoof</div>' +
      '<form action="https://evil.example"><input name="p"><button>Sign in</button></form>' +
      '<script>window.__pwned = 1</script>'
    ));
    await zoomIntoParent(page);

    const display = page.locator('.zoom-desc-display');
    await expect(display).toContainText('spoof');
    await expect(display.locator('.modal-overlay')).toHaveCount(0);
    await expect(display.locator('form')).toHaveCount(0);
    await expect(display.locator('input')).toHaveCount(0);
    await expect(display.locator('button')).toHaveCount(0);
    await expect(display.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });

  test('zoomed description images are capped to the container width', async ({ page }) => {
    await page.route('https://images.example/**', (route) => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"></svg>'
    }));

    await setupDoc(page, docWithDescription('![Big](https://images.example/big.svg)'));
    await zoomIntoParent(page);

    const image = page.locator('.zoom-desc-display img');
    await expect(image).toBeVisible();
    expect(await image.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('100%');

    const imageBox = (await image.boundingBox())!;
    const containerBox = (await page.locator('.zoom-desc-display').boundingBox())!;
    expect(imageBox.width).toBeLessThanOrEqual(containerBox.width + 1);
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  test('inline description images are capped to the container width', async ({ page }) => {
    await page.route('https://images.example/**', (route) => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"></svg>'
    }));

    await setupDoc(page, docWithDescription('![Big](https://images.example/big.svg)'));

    const image = page.locator('[data-node-id="1"] .node-desc-md img');
    await expect(image).toBeVisible();
    expect(await image.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('100%');
    const imageBox = (await image.boundingBox())!;
    const containerBox = (await page.locator('[data-node-id="1"] .node-desc-md').boundingBox())!;
    expect(imageBox.width).toBeLessThanOrEqual(containerBox.width + 1);
  });

  test('a long unbroken description wraps in the inline editor', async ({ page }) => {
    await setupDoc(page, docWithDescription(''));

    const node = page.locator('[data-node-id="1"]');
    await node.locator('.node-text-md').click();
    await node.locator('input').press('Shift+Enter');

    const textarea = node.locator('textarea.node-desc-textarea');
    await expect(textarea).toBeFocused();
    await textarea.fill('A'.repeat(240));

    const metrics = await textarea.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight)
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    // Wrapped onto several lines rather than spilling sideways.
    expect(metrics.clientHeight).toBeGreaterThan(metrics.lineHeight * 1.5);
  });

  test('a long unbroken description wraps in the zoomed editor', async ({ page }) => {
    await setupDoc(page, docWithDescription(''));

    await page.locator('[data-node-id="1"] .node-text-md').click();
    await page.keyboard.press('Alt+ArrowRight');
    await page.locator('.zoom-desc-display').click();

    const textarea = page.locator('.zoom-desc-textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill('A'.repeat(240));

    const metrics = await textarea.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight)
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.lineHeight * 1.5);
  });

  test('the in-app markdown demo renders block markdown when zoomed', async ({ page }) => {
    // First-ever visit: memory mode loads the intro tour without a lock screen.
    await page.goto('/');
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    const demo = page.locator('.node-content', { hasText: 'Write with light markdown' }).first();
    await demo.locator('.node-text-md').click();
    await page.keyboard.press('Alt+ArrowRight');

    const display = page.locator('.zoom-desc-display');
    await expect(display.locator('h2')).toContainText('Headings, lists, quotes');
    await expect(display.locator('pre code')).toContainText('fenced code and tables too');
    await expect(display.locator('table')).toBeVisible();
  });
});
