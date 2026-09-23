import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Markdown Rendering', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Normal Item', children: [] },
        { id: '2', text: '**Bold Item**', children: [] },
        { id: '3', text: '_Italic Item_', children: [] },
        { id: '4', text: '[Virgulas](https://example.com)', children: [] },
        { id: '5', text: '![Logo](https://example.com/logo.png)', children: [] },
        { id: '6', text: '`const x = 1`', children: [] },
        { id: '7', text: '![' + '" onerror="alert(1)](https://x.com)', children: [] },
        { id: '8', text: 'Ping @alice about #todo', children: [] }
      ]
    });
  });

  test('Renders markdown when not focused', async ({ page }) => {
    // Check Bold Item
    // It should NOT be an input, but a div with strong tag
    // Wait, initially focus might be on first item? Or none?
    // FocusPath is null initially. So all should be rendered as markdown if they have text?
    // Code: showMarkdown = !isEditing && !readOnly && node.text;
    // Initial render: isEditing is false.
    // So all items should be markdown.

    // Check Item 2
    const boldNode = page.locator('strong', { hasText: 'Bold Item' });
    await expect(boldNode).toBeVisible();

    // Check Italic Item
    const italicNode = page.locator('em', { hasText: 'Italic Item' });
    await expect(italicNode).toBeVisible();

    // Check Normal Item
    // It should also be rendered as div, but no special tag. Just text.
    // Text: "Normal Item"
    const normalText = page.getByText('Normal Item', { exact: true });
    await expect(normalText).toBeVisible();
  });

  test('Switches to input on click', async ({ page }) => {
    // Bold Item is 2nd node (index 1)
    // Structure:
    // .node-content (Normal)
    // .node-content (Bold)
    // .node-content (Italic)

    const boldNodeWrapper = page.locator('.node-content').nth(1);

    // Click it
    await boldNodeWrapper.click();

    // Now it should be an input with value "**Bold Item**"
    const input = boldNodeWrapper.locator('input');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('**Bold Item**');

    // And strong tag should be gone
    await expect(boldNodeWrapper.locator('strong')).not.toBeVisible();
  });

  test('Switches back to markdown on blur', async ({ page }) => {
    const boldNodeWrapper = page.locator('.node-content').nth(1);
    const normalNodeWrapper = page.locator('.node-content').nth(0);

    // Click Bold Item to edit
    await boldNodeWrapper.click();
    await expect(boldNodeWrapper.locator('input')).toBeVisible();

    // Click Normal Item to move focus
    await normalNodeWrapper.click();

    // Bold Item should be markdown again
    await expect(boldNodeWrapper.locator('strong')).toBeVisible();

    // Normal Item should be input
    const normalInput = normalNodeWrapper.locator('input');
    await expect(normalInput).toBeVisible();
  });

  test('Renders links, images, and inline code', async ({ page }) => {
    const link = page.locator('a[href="https://example.com"]');
    await expect(link).toHaveText('Virgulas');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    const image = page.locator('img[src="https://example.com/logo.png"][alt="Logo"]');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(image).toHaveAttribute('loading', 'lazy');

    await expect(page.locator('code', { hasText: 'const x = 1' })).toBeVisible();
  });

  test('Clicking markdown links opens a new tab and does not switch to edit mode', async ({ page, context }) => {
    const node = page.locator('.node-content').nth(3);
    const link = node.locator('a[href="https://example.com"]');

    const popupPromise = context.waitForEvent('page');
    await link.click();
    const popup = await popupPromise;

    await expect(node.locator('input')).toHaveCount(0);
    await popup.close();
  });

  test('Highlights tags and mentions and clicking them opens search with the token', async ({ page }) => {
    const mentionToken = page.locator('[data-search-token="@alice"]');
    const tagToken = page.locator('[data-search-token="#todo"]');

    await expect(mentionToken).toBeVisible();
    await expect(mentionToken).toHaveClass(/search-token-mention/);
    await expect(tagToken).toBeVisible();
    await expect(tagToken).toHaveClass(/search-token-tag/);

    await tagToken.click();

    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveValue('#todo');
  });

  test('Escapes markdown quotes to prevent attribute injection', async ({ page }) => {
    const image = page.locator('img[src="https://x.com"]');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', '" onerror="alert(1)');
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');

    const hasInlineOnError = await image.evaluate((el) => el.hasAttribute('onerror'));
    expect(hasInlineOnError).toBe(false);
  });

  test('Loads images normally but strips referrer and event handlers', async ({ page }) => {
    await page.route('https://tracker.example/**', (route) => route.abort());

    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{
        id: 'tracked',
        text: '![beacon](https://tracker.example/pixel.png) <img src="https://tracker.example/raw.png" onerror="window.__pwned=1">',
        children: []
      }]
    });

    const markdownImage = page.locator('img[src="https://tracker.example/pixel.png"]');
    await expect(markdownImage).toHaveCount(1);
    await expect(markdownImage).toHaveAttribute('referrerpolicy', 'no-referrer');

    const rawImage = page.locator('img[src="https://tracker.example/raw.png"]');
    await expect(rawImage).toHaveCount(1);
    await expect(rawImage).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(await rawImage.evaluate((el) => el.hasAttribute('onerror'))).toBe(false);
  });

  test('Raw HTML cannot spoof app chrome or render forms', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{
        id: 'injected',
        text: '<div class="modal-overlay" id="app" style="position:fixed;inset:0">spoof</div><form action="https://evil.example"><input name="p"><button>Sign in</button></form>',
        children: []
      }]
    });

    const rendered = page.locator('.node-text-md').first();
    await expect(rendered).toContainText('spoof');
    await expect(rendered.locator('.modal-overlay')).toHaveCount(0);
    await expect(rendered.locator('form')).toHaveCount(0);
    await expect(rendered.locator('input')).toHaveCount(0);
  });

  // The unit suite runs in happy-dom, where DOMPurify does not behave like a real
  // DOM (it drops allowed <strong> and lets <script> through), so sanitisation is
  // only meaningfully verified here, in Chromium.
  test('Raw script and event handlers never reach the DOM', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{
        id: 'scripted',
        text: '<script>window.__pwned = 1</script>after<script src="https://evil.example/x.js"></script>',
        children: []
      }]
    });

    const rendered = page.locator('.node-text-md').first();
    await expect(rendered).toContainText('after');
    await expect(rendered.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });
});
