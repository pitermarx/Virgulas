// @ts-check
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Clear localStorage to ensure a fresh seeded state for each test
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.bullet-row');
});

test.describe('App loads', () => {
  test('renders the outliner with seeded bullets', async ({ page }) => {
    const rows = page.locator('.bullet-row');
    await expect(rows).toHaveCount(7); // 5 top-level + 2 children of item 3
    await expect(page.locator('.bullet-text').first()).toBeVisible();
  });

  test('shows the toolbar', async ({ page }) => {
    await expect(page.locator('#toolbar')).toBeVisible();
  });

  test('page title is Outliner', async ({ page }) => {
    await expect(page).toHaveTitle('Outliner');
  });
});

test.describe('Creating bullets', () => {
  test('Enter creates a new bullet after the current one', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const rows = page.locator('.bullet-row');
    await expect(rows).toHaveCount(8);
  });

  test('new bullet gets focus after creation', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Enter');
    const newBullet = page.locator('.bullet-row.focused');
    await expect(newBullet).toBeVisible();
  });
});

test.describe('Editing bullets', () => {
  test('can type text into a bullet', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await firstText.fill('Hello World');
    await firstText.blur();
    await expect(firstText).toContainText('Hello World');
  });

  test('text is persisted in localStorage on blur', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await firstText.fill('Persisted text');
    await firstText.blur();

    // Reload and verify persistence
    await page.reload();
    await page.waitForSelector('.bullet-row');
    await expect(page.locator('.bullet-text').first()).toContainText('Persisted text');
  });

  test('Backspace on empty bullet deletes it', async ({ page }) => {
    // Create a new empty bullet then delete it
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    // Wait for a focused empty bullet to appear
    const focusedRow = page.locator('.bullet-row.focused');
    await expect(focusedRow).toBeVisible();
    const countBefore = await page.locator('.bullet-row').count();

    // Ensure the focused bullet text is empty before backspacing
    const focusedText = focusedRow.locator('.bullet-text');
    await focusedText.fill('');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.bullet-row')).toHaveCount(countBefore - 1);
  });
});

test.describe('Indenting bullets', () => {
  test('Tab indents a bullet', async ({ page }) => {
    // Get the second bullet (first bullet cannot be indented as idx=0)
    const secondText = page.locator('.bullet-text').nth(1);
    const secondRow = page.locator('.bullet-row').nth(1);
    const marginBefore = await secondRow.evaluate(el => el.style.marginLeft);

    await secondText.click();
    await page.keyboard.press('Tab');

    const marginAfter = await secondRow.evaluate(el => el.style.marginLeft);
    expect(marginAfter).not.toBe(marginBefore);
  });

  test('Shift+Tab unindents a bullet', async ({ page }) => {
    // First indent the second bullet
    const secondText = page.locator('.bullet-text').nth(1);
    await secondText.click();
    await page.keyboard.press('Tab');

    const secondRow = page.locator('.bullet-row').nth(1);
    const marginAfterIndent = await secondRow.evaluate(el => el.style.marginLeft);

    await secondText.click();
    await page.keyboard.press('Shift+Tab');

    const marginAfterUnindent = await secondRow.evaluate(el => el.style.marginLeft);
    expect(marginAfterUnindent).not.toBe(marginAfterIndent);
  });
});

test.describe('Moving bullets', () => {
  test('Alt+ArrowDown moves bullet down', async ({ page }) => {
    const firstRow = page.locator('.bullet-row').first();
    const firstId = await firstRow.getAttribute('data-id');

    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Alt+ArrowDown');

    // The first bullet's ID should now appear as the second row
    const newSecondRow = page.locator('.bullet-row').nth(1);
    await expect(newSecondRow).toHaveAttribute('data-id', firstId);
  });

  test('Alt+ArrowUp moves bullet up', async ({ page }) => {
    const secondRow = page.locator('.bullet-row').nth(1);
    const secondId = await secondRow.getAttribute('data-id');

    const secondText = page.locator('.bullet-text').nth(1);
    await secondText.click();
    await page.keyboard.press('Alt+ArrowUp');

    // The second bullet's ID should now appear as the first row
    const newFirstRow = page.locator('.bullet-row').first();
    await expect(newFirstRow).toHaveAttribute('data-id', secondId);
  });
});

test.describe('Zoom', () => {
  test('clicking bullet dot zooms into it', async ({ page }) => {
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();

    await expect(page.locator('#zoom-title')).toBeVisible();
    await expect(page.locator('#breadcrumb')).toBeVisible();
  });

  test('breadcrumb shows after zoom', async ({ page }) => {
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();
    await expect(page.locator('#breadcrumb')).toBeVisible();
  });

  test('Alt+ArrowLeft zooms out', async ({ page }) => {
    // Zoom into first bullet
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();
    await page.waitForSelector('#zoom-title:not(.hidden)');

    // Zoom back out using keyboard
    const firstChildText = page.locator('.bullet-text').first();
    await firstChildText.click();
    await page.keyboard.press('Alt+ArrowLeft');

    await expect(page.locator('#zoom-title')).toBeHidden();
  });

  test('Alt+ArrowRight zooms into a bullet via keyboard', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('#zoom-title')).toBeVisible();
    await expect(page.locator('#breadcrumb')).toBeVisible();
  });
});

test.describe('Collapse / Expand', () => {
  test('collapse toggle hides children', async ({ page }) => {
    // The 3rd bullet has children. Find the row with children
    const parentRow = page.locator('.bullet-row.has-children').first();
    const toggle = parentRow.locator('.collapse-toggle.active');

    const childCountBefore = await page.locator('.bullet-row').count();
    await toggle.click();

    const childCountAfter = await page.locator('.bullet-row').count();
    expect(childCountAfter).toBeLessThan(childCountBefore);
  });

  test('Ctrl+Space toggles collapse via keyboard', async ({ page }) => {
    // Find first bullet with children
    const parentText = page.locator('.bullet-row.has-children .bullet-text').first();
    await parentText.click();

    const countBefore = await page.locator('.bullet-row').count();
    await page.keyboard.press('Control+Space');

    const countAfter = await page.locator('.bullet-row').count();
    expect(countAfter).not.toBe(countBefore);
  });
});

test.describe('Description', () => {
  test('Ctrl+Enter shows description textarea', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Control+Enter');

    const desc = page.locator('.bullet-desc.visible').first();
    await expect(desc).toBeVisible();
  });

  test('Escape from description refocuses bullet text', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Control+Enter');

    await page.keyboard.press('Escape');
    await expect(firstText).toBeFocused();
  });
});

test.describe('Search', () => {
  test('Ctrl+F opens search bar', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await expect(page.locator('#search-bar')).toBeVisible();
  });

  test('search highlights matching bullets', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.locator('#search-input').fill('Tab');
    await expect(page.locator('.bullet-row.search-match').first()).toBeVisible();
  });

  test('Escape closes search bar', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.locator('#search-input').press('Escape');
    await expect(page.locator('#search-bar')).toBeHidden();
  });

  test('search count updates when typing', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.locator('#search-input').fill('Tab');
    const count = page.locator('#search-count');
    await expect(count).not.toHaveText('');
  });
});

test.describe('Markdown rendering', () => {
  test('bold markdown renders as <strong>', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await firstText.fill('**bold text**');
    // Blur to trigger rendering
    await page.keyboard.press('Tab');
    // Shift+Tab to undo indent
    await page.keyboard.press('Shift+Tab');

    await expect(page.locator('.bullet-text strong').first()).toBeVisible();
  });

  test('inline code renders as <code>', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await firstText.fill('`code snippet`');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');

    await expect(page.locator('.bullet-text code').first()).toBeVisible();
  });
});

test.describe('Import / Export', () => {
  test('export modal opens', async ({ page }) => {
    const exportBtn = page.locator('#toolbar').getByText('Export');
    await exportBtn.click();
    await expect(page.locator('#modal-export')).toBeVisible();
  });

  test('import modal opens', async ({ page }) => {
    const importBtn = page.locator('#toolbar').getByText('Import');
    await importBtn.click();
    await expect(page.locator('#modal-import')).toBeVisible();
  });

  test('export produces markdown text', async ({ page }) => {
    const exportBtn = page.locator('#toolbar').getByText('Export');
    await exportBtn.click();
    const exportText = page.locator('#modal-export textarea');
    await expect(exportText).not.toBeEmpty();
    const content = await exportText.inputValue();
    expect(content).toMatch(/^- /m);
  });

  test('copy button in export modal copies to clipboard and shows feedback', async ({ page }) => {
    // The clipboard API requires explicit permission in Playwright
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const exportBtn = page.locator('#toolbar').getByText('Export');
    await exportBtn.click();
    const copyBtn = page.locator('#btn-copy-export');
    await copyBtn.click();
    // Button label changes to 'Copied!' to confirm action
    await expect(copyBtn).toHaveText('Copied!');
  });
});

test.describe('Arrow key navigation', () => {
  test('ArrowDown moves focus to the next bullet', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('ArrowDown');

    // The second row should now be focused
    const secondRow = page.locator('.bullet-row').nth(1);
    await expect(secondRow).toHaveClass(/focused/);
  });

  test('ArrowUp moves focus to the previous bullet', async ({ page }) => {
    const secondText = page.locator('.bullet-text').nth(1);
    await secondText.click();
    await page.keyboard.press('ArrowUp');

    // The first row should now be focused
    const firstRow = page.locator('.bullet-row').first();
    await expect(firstRow).toHaveClass(/focused/);
  });
});

test.describe('Empty hint', () => {
  test('empty hint is hidden when there are bullets', async ({ page }) => {
    await expect(page.locator('#empty-hint')).toBeHidden();
  });

  test('empty hint is shown when there are no bullets and clicking it creates one', async ({ page }) => {
    // Set up an empty document directly in localStorage
    await page.evaluate(() => {
      localStorage.setItem('outline_v1', JSON.stringify({
        root: { id: 'root', text: 'root', description: '', children: [], collapsed: false },
        version: 1
      }));
    });
    await page.reload();

    await expect(page.locator('#empty-hint')).toBeVisible();

    // Clicking the hint should create a new bullet
    await page.locator('#empty-hint').click();
    await expect(page.locator('.bullet-row')).toHaveCount(1);
  });
});
