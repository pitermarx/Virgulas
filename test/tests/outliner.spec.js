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

  test('Ctrl+Backspace on empty bullet deletes it', async ({ page }) => {
    // Create a new empty bullet then delete it
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    // Wait for a focused empty bullet to appear
    const focusedRow = page.locator('.bullet-row.focused');
    await expect(focusedRow).toBeVisible();
    const countBefore = await page.locator('.bullet-row').count();

    // Delete with Ctrl+Backspace
    await page.keyboard.press('Control+Backspace');
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
  test('Shift+Enter shows description textarea', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Shift+Enter');

    const desc = page.locator('.bullet-desc.editing').first();
    await expect(desc).toBeVisible();
  });

  test('Escape from description refocuses bullet text', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Shift+Enter');

    await page.keyboard.press('Escape');
    await expect(firstText).toBeFocused();
  });

  test('description view shows when description has content', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Shift+Enter');

    const descEl = page.locator('.bullet-desc.editing').first();
    await descEl.fill('My description text');
    await descEl.press('Escape');

    const descView = page.locator('.bullet-desc-view.visible').first();
    await expect(descView).toBeVisible();
    await expect(descView).toContainText('My description text');
  });

  test('description top position does not shift between view and edit mode', async ({ page }) => {
    // Enter a description
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Shift+Enter');
    const descEl = page.locator('.bullet-desc.editing').first();
    await descEl.fill('Alignment test');
    await descEl.press('Escape');

    // Measure the top position of the view element
    const descView = page.locator('.bullet-desc-view.visible').first();
    await expect(descView).toBeVisible();
    const viewBox = await descView.boundingBox();

    // Switch to edit mode by clicking on the description
    await descView.click();
    const descEditing = page.locator('.bullet-desc.editing').first();
    await expect(descEditing).toBeVisible();
    const editBox = await descEditing.boundingBox();

    // The top position should not shift by more than 1px
    expect(Math.abs(editBox.y - viewBox.y)).toBeLessThanOrEqual(1);
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
  test('Markdown button opens modal', async ({ page }) => {
    const mdBtn = page.locator('#toolbar').getByText('Markdown');
    await mdBtn.click();
    await expect(page.locator('#modal-markdown')).toBeVisible();
  });

  test('Markdown modal shows current outline as markdown', async ({ page }) => {
    const mdBtn = page.locator('#toolbar').getByText('Markdown');
    await mdBtn.click();
    const mdText = page.locator('#markdown-text');
    await expect(mdText).not.toBeEmpty();
    const content = await mdText.inputValue();
    expect(content).toMatch(/^- /m);
  });

  test('Apply button imports edited markdown', async ({ page }) => {
    const mdBtn = page.locator('#toolbar').getByText('Markdown');
    await mdBtn.click();
    const mdText = page.locator('#markdown-text');
    await mdText.fill('- New Item\n- Another Item');
    await page.locator('#btn-apply-markdown').click();

    const rows = page.locator('.bullet-row');
    await expect(rows).toHaveCount(2);
  });
});

test.describe('Ctrl+Backspace deletion', () => {
  test('Ctrl+Backspace deletes a bullet', async ({ page }) => {
    // Create a new bullet first
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    const focusedRow = page.locator('.bullet-row.focused');
    await expect(focusedRow).toBeVisible();
    const countBefore = await page.locator('.bullet-row').count();

    // Type some text so the node is non-empty
    await page.keyboard.type('to delete');
    await page.keyboard.press('Control+Backspace');
    await expect(page.locator('.bullet-row')).toHaveCount(countBefore - 1);
  });

  test('Ctrl+Backspace on node with children shows confirmation', async ({ page }) => {
    // Find the parent node that has children
    const parentRow = page.locator('.bullet-row.has-children').first();
    const parentText = parentRow.locator('.bullet-text');
    await parentText.click();

    // Listen for dialog and dismiss it (cancel)
    page.once('dialog', dialog => dialog.dismiss());
    await page.keyboard.press('Control+Backspace');

    // Node should still be there
    await expect(parentRow).toBeVisible();
  });

  test('Ctrl+Backspace on node with children deletes after confirmation', async ({ page }) => {
    const countBefore = await page.locator('.bullet-row').count();
    const parentRow = page.locator('.bullet-row.has-children').first();
    const parentText = parentRow.locator('.bullet-text');
    await parentText.click();

    // Accept the confirmation dialog
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Control+Backspace');

    // The parent and its children should be gone
    const countAfter = await page.locator('.bullet-row').count();
    expect(countAfter).toBeLessThan(countBefore);
  });
});

test.describe('Undo', () => {
  test('Ctrl+Z undoes bullet creation', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    const countAfterCreate = await page.locator('.bullet-row').count();

    // Undo
    await page.keyboard.press('Control+z');
    const countAfterUndo = await page.locator('.bullet-row').count();
    expect(countAfterUndo).toBe(countAfterCreate - 1);
  });

  test('Ctrl+Z undoes indent', async ({ page }) => {
    const secondText = page.locator('.bullet-text').nth(1);
    const secondRow = page.locator('.bullet-row').nth(1);
    await secondText.click();
    await page.keyboard.press('Tab');
    const marginAfterIndent = await secondRow.evaluate(el => el.style.marginLeft);

    await page.keyboard.press('Control+z');
    const marginAfterUndo = await secondRow.evaluate(el => el.style.marginLeft);
    expect(marginAfterUndo).not.toBe(marginAfterIndent);
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

  test('ArrowDown with no item focused moves focus to the first bullet', async ({ page }) => {
    // Ensure no bullet is focused by clicking outside
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.bullet-row.focused')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');

    const firstRow = page.locator('.bullet-row').first();
    await expect(firstRow).toHaveClass(/focused/);
  });

  test('ArrowUp with no item focused moves focus to the last bullet', async ({ page }) => {
    // Ensure no bullet is focused by clicking outside
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.bullet-row.focused')).toHaveCount(0);

    await page.keyboard.press('ArrowUp');

    const lastRow = page.locator('.bullet-row').last();
    await expect(lastRow).toHaveClass(/focused/);
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
