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
    await expect(rows).toHaveCount(8); // 6 top-level seed bullets + 2 children of third seed bullet
    await expect(page.locator('.bullet-text').first()).toBeVisible();
  });

  test('seeded bullets have descriptions visible', async ({ page }) => {
    // All top-level seed bullets have descriptions, so .bullet-desc-view.visible should be present
    const descViews = page.locator('.bullet-desc-view.visible');
    await expect(descViews.first()).toBeVisible();
  });

  test('shows the toolbar', async ({ page }) => {
    await expect(page.locator('#toolbar')).toBeVisible();
  });

  test('page title is Virgulas', async ({ page }) => {
    await expect(page).toHaveTitle('Virgulas');
  });
});

test.describe('Creating bullets', () => {
  test('Enter creates a new bullet after the current one', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const rows = page.locator('.bullet-row');
    await expect(rows).toHaveCount(9);
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

  test('unindenting adopts subsequent siblings as children', async ({ page }) => {
    // Set up: root → [a] where a has children [b, c]
    await page.evaluate(() => {
      let nodeCounter = 0;
      const makeNode = (text, children = []) => ({
        id: `test-node-${++nodeCounter}`,
        text,
        description: '',
        children,
        collapsed: false,
      });
      const c = makeNode('c');
      const b = makeNode('b');
      const a = makeNode('a', [b, c]);
      localStorage.setItem('outline_v1', JSON.stringify({
        root: { id: 'root', text: 'root', description: '', children: [a], collapsed: false },
        version: 1,
      }));
    });
    await page.reload();
    await page.waitForSelector('.bullet-row');

    // Click b's text (second visible bullet after a) and unindent it
    const bText = page.locator('.bullet-text').nth(1);
    await bText.click();
    await page.keyboard.press('Shift+Tab');

    // All three rows (a, b, c) should still be visible
    const rows = page.locator('.bullet-row');
    await expect(rows).toHaveCount(3);

    // a should no longer have children
    const aRow = page.locator('.bullet-row').nth(0);
    await expect(aRow).not.toHaveClass(/has-children/);

    // b should now have children (c was adopted)
    const bRow = page.locator('.bullet-row').nth(1);
    await expect(bRow).toHaveClass(/has-children/);

    // c should be deeper than b (indented further)
    const bMargin = await bRow.evaluate(el => parseInt(el.style.marginLeft) || 0);
    const cRow = page.locator('.bullet-row').nth(2);
    const cMargin = await cRow.evaluate(el => parseInt(el.style.marginLeft) || 0);
    expect(cMargin).toBeGreaterThan(bMargin);
  });
});

test.describe('Swipe to indent/unindent (mobile)', () => {
  /** Dispatch a synthetic horizontal swipe on the given CSS selector. */
  async function simulateSwipe(page, selector, deltaX) {
    await page.evaluate(([sel, dx]) => {
      const row = document.querySelector(sel);
      if (!row) return;
      const rect = row.getBoundingClientRect();
      const sx = rect.left + rect.width / 2;
      const sy = rect.top + rect.height / 2;
      const startTouch = new Touch({ identifier: 1, target: row, clientX: sx, clientY: sy });
      const endTouch = new Touch({ identifier: 1, target: row, clientX: sx + dx, clientY: sy });
      row.dispatchEvent(new TouchEvent('touchstart', { touches: [startTouch], changedTouches: [startTouch], bubbles: true }));
      row.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [endTouch], bubbles: true }));
    }, [selector, deltaX]);
  }

  test('swipe right indents a bullet', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Touch constructor not available in non-touch Firefox');
    const secondRow = page.locator('.bullet-row').nth(1);
    const marginBefore = await secondRow.evaluate(el => el.style.marginLeft);
    const secondRowId = await secondRow.getAttribute('data-id');

    await simulateSwipe(page, `.bullet-row[data-id="${secondRowId}"]`, 80);

    const marginAfter = await secondRow.evaluate(el => el.style.marginLeft);
    expect(marginAfter).not.toBe(marginBefore);
  });

  test('swipe left unindents a bullet', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Touch constructor not available in non-touch Firefox');
    // First indent the second bullet via keyboard
    const secondText = page.locator('.bullet-text').nth(1);
    await secondText.click();
    await page.keyboard.press('Tab');

    const secondRow = page.locator('.bullet-row').nth(1);
    const marginAfterIndent = await secondRow.evaluate(el => el.style.marginLeft);
    const secondRowId = await secondRow.getAttribute('data-id');

    // Swipe left to unindent
    await simulateSwipe(page, `.bullet-row[data-id="${secondRowId}"]`, -80);

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

  test('zooming into a bullet focuses the header, not a new item', async ({ page }) => {
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();

    await expect(page.locator('#zoom-title')).toBeFocused();
  });

  test('Alt+ArrowLeft zooms out', async ({ page }) => {
    // Zoom into first bullet
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();

    // Zoom back out using Alt+ArrowLeft from the focused header
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

  test('Enter on zoom header creates a new first child', async ({ page }) => {
    // Zoom into the third bullet which has children
    const thirdDot = page.locator('.bullet-dot').nth(2);
    await thirdDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();

    const countBefore = await page.locator('.bullet-row').count();
    await page.keyboard.press('Enter');

    await expect(page.locator('.bullet-row')).toHaveCount(countBefore + 1);
    await expect(page.locator('.bullet-row.focused')).toBeVisible();
  });

  test('ArrowDown from zoom header focuses first bullet', async ({ page }) => {
    // Zoom into the third bullet which has children
    const thirdDot = page.locator('.bullet-dot').nth(2);
    await thirdDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();

    await page.keyboard.press('ArrowDown');

    await expect(page.locator('.bullet-text').first()).toBeFocused();
  });

  test('ArrowUp from first bullet focuses zoom header when zoomed', async ({ page }) => {
    // Zoom into the third bullet which has children
    const thirdDot = page.locator('.bullet-dot').nth(2);
    await thirdDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();

    // Move to first bullet, then back up to header
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.bullet-text').first()).toBeFocused();
    await page.keyboard.press('ArrowUp');

    await expect(page.locator('#zoom-title')).toBeFocused();
  });

  test('Shift+Enter on zoom header focuses zoom description', async ({ page }) => {
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();

    await page.keyboard.press('Shift+Enter');

    await expect(page.locator('#zoom-desc')).toBeFocused();
  });

  test('Escape from zoom description returns focus to zoom header', async ({ page }) => {
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#zoom-desc')).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(page.locator('#zoom-title')).toBeFocused();
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

  test('bullet-desc-view has font-size 0.867rem and line-height 1.25rem', async ({ page }) => {
    const descView = page.locator('.bullet-desc-view').first();
    // Get the root font size to compute expected rem-based values
    const rootFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const fontSize = await descView.evaluate(el => getComputedStyle(el).fontSize);
    const lineHeight = await descView.evaluate(el => getComputedStyle(el).lineHeight);
    expect(parseFloat(fontSize)).toBeCloseTo(0.867 * rootFontSize, 0);
    expect(parseFloat(lineHeight)).toBeCloseTo(1.25 * rootFontSize, 0);
  });

  test('bullet-desc has font-size 0.867rem and line-height 1.25rem', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Shift+Enter');
    const descEl = page.locator('.bullet-desc.editing').first();
    await expect(descEl).toBeVisible();
    // Get the root font size to compute expected rem-based values
    const rootFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const fontSize = await descEl.evaluate(el => getComputedStyle(el).fontSize);
    const lineHeight = await descEl.evaluate(el => getComputedStyle(el).lineHeight);
    expect(parseFloat(fontSize)).toBeCloseTo(0.867 * rootFontSize, 0);
    expect(parseFloat(lineHeight)).toBeCloseTo(1.25 * rootFontSize, 0);
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
    expect(content).toMatch(/^[+-] /m);
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

  test('Export uses - for expanded and + for collapsed nodes', async ({ page }) => {
    // Create a parent with a child, then collapse the parent
    const mdBtn = page.locator('#toolbar').getByText('Markdown');
    await mdBtn.click();
    await page.locator('#markdown-text').fill('- Parent\n  - Child\n- Standalone');
    await page.locator('#btn-apply-markdown').click();

    // Collapse the first bullet (Parent) via Ctrl+Space
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Control+Space');

    // Open the markdown modal and check the export
    await page.locator('#toolbar').getByText('Markdown').click();
    const content = await page.locator('#markdown-text').inputValue();
    // Collapsed parent should export as '+ Parent'
    expect(content).toMatch(/^\+ Parent$/m);
    // Standalone (expanded) should export as '- Standalone'
    expect(content).toMatch(/^- Standalone$/m);
  });

  test('Import restores collapsed state from + bullet', async ({ page }) => {
    const mdBtn = page.locator('#toolbar').getByText('Markdown');
    await mdBtn.click();
    // Use + for a collapsed node (with a child) and - for expanded
    await page.locator('#markdown-text').fill('+ Collapsed\n  - Child\n- Expanded');
    await page.locator('#btn-apply-markdown').click();

    // The collapsed row should have the 'collapsed' CSS class
    const collapsedRow = page.locator('.bullet-row').first();
    await expect(collapsedRow).toHaveClass(/collapsed/);

    // The expanded row should NOT have the 'collapsed' CSS class
    const expandedRow = page.locator('.bullet-row').nth(1);
    await expect(expandedRow).not.toHaveClass(/collapsed/);
  });

  test('Collapsed state round-trips through export and import', async ({ page }) => {
    // Set up a two-level outline with a collapsed parent
    const mdBtn = page.locator('#toolbar').getByText('Markdown');
    await mdBtn.click();
    await page.locator('#markdown-text').fill('- Parent\n  - Child\n- Other');
    await page.locator('#btn-apply-markdown').click();

    // Collapse the first bullet
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Control+Space');

    // Export, then re-import the markdown
    await page.locator('#toolbar').getByText('Markdown').click();
    const exported = await page.locator('#markdown-text').inputValue();
    await page.locator('#markdown-text').fill(exported);
    await page.locator('#btn-apply-markdown').click();

    // The first bullet should still be collapsed after the round-trip
    const firstRow = page.locator('.bullet-row').first();
    await expect(firstRow).toHaveClass(/collapsed/);
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
  test('empty hint is always visible at the end of the list', async ({ page }) => {
    await expect(page.locator('#empty-hint')).toBeVisible();
  });

  test('clicking empty hint creates a new bullet', async ({ page }) => {
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

test.describe('Enter when unfocused', () => {
  test('pressing Enter when no bullet is focused adds a new bullet at the end', async ({ page }) => {
    // Ensure no bullet is focused by pressing Escape
    await page.locator('.bullet-text').first().click();
    await page.keyboard.press('Escape');

    const countBefore = await page.locator('.bullet-row').count();
    await page.keyboard.press('Enter');
    await expect(page.locator('.bullet-row')).toHaveCount(countBefore + 1);

    // The new bullet should be focused at the end
    const lastRow = page.locator('.bullet-row').last();
    await expect(lastRow).toHaveClass(/focused/);
  });

  test('pressing Enter on an empty page adds a first bullet', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('outline_v1', JSON.stringify({
        root: { id: 'root', text: 'root', description: '', children: [], collapsed: false },
        version: 1
      }));
    });
    await page.reload();

    await page.keyboard.press('Enter');
    await expect(page.locator('.bullet-row')).toHaveCount(1);
  });
});

test.describe('Options dialog', () => {
  test('Options button is visible in toolbar', async ({ page }) => {
    await expect(page.locator('#btn-options')).toBeVisible();
  });

  test('clicking Options button opens the Options modal', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#modal-options')).not.toHaveClass(/hidden/);
  });

  test('Options modal contains Sign in and Theme toggle buttons', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#btn-sign-in')).toBeVisible();
    await expect(page.locator('#btn-toggle-theme')).toBeVisible();
  });

  test('Options modal contains a GitHub link', async ({ page }) => {
    await page.click('#btn-options');
    const link = page.locator('#link-github');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://github.com/pitermarx/Virgulas');
  });

  test('theme toggle switches to dark mode', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.click('#btn-toggle-theme');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#btn-toggle-theme')).toContainText('Switch to light mode');
  });

  test('theme toggle switches back to light mode', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-theme');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.click('#btn-toggle-theme');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#btn-toggle-theme')).toContainText('Switch to dark mode');
  });

  test('theme persists after reload', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-theme');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await page.waitForSelector('.bullet-row');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('Options modal can be closed with Escape', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#modal-options')).not.toHaveClass(/hidden/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-options')).toHaveClass(/hidden/);
  });

  test('Options modal can be closed by clicking the overlay', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#modal-options')).not.toHaveClass(/hidden/);
    await page.locator('#modal-options').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#modal-options')).toHaveClass(/hidden/);
  });
});

test.describe('Authentication', () => {
  test('Options modal shows Sign in button when not logged in', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#btn-sign-in')).toBeVisible();
  });

  test('clicking Sign in button opens login modal', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#modal-login')).not.toHaveClass(/hidden/);
  });

  test('login modal contains email and password fields', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
  });

  test('login modal shows error when fields are empty', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await page.click('#btn-login-submit');
    await expect(page.locator('#login-error')).not.toHaveClass(/hidden/);
    await expect(page.locator('#login-error')).toContainText('required');
  });

  test('login modal can be closed with Escape', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#modal-login')).not.toHaveClass(/hidden/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-login')).toHaveClass(/hidden/);
  });

  test('login modal can be closed with Cancel button', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#modal-login')).not.toHaveClass(/hidden/);
    await page.locator('#modal-login .btn-secondary').click();
    await expect(page.locator('#modal-login')).toHaveClass(/hidden/);
  });

  test('login modal can be closed by clicking the overlay', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#modal-login')).not.toHaveClass(/hidden/);
    await page.locator('#modal-login').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#modal-login')).toHaveClass(/hidden/);
  });

  test('login modal has a Sign up toggle link', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#btn-login-switch')).toBeVisible();
    await expect(page.locator('#btn-login-switch')).toContainText('Sign up');
  });

  test('clicking Sign up link switches modal to sign-up mode', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await page.click('#btn-login-switch');
    await expect(page.locator('#login-modal-title')).toContainText('Sign up');
    await expect(page.locator('#btn-login-submit')).toContainText('Sign up');
    await expect(page.locator('#login-confirm-password')).toBeVisible();
    await expect(page.locator('#btn-login-switch')).toContainText('Sign in');
  });

  test('sign-up mode shows error when passwords do not match', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await page.click('#btn-login-switch');
    await page.fill('#login-email', 'test@example.com');
    await page.fill('#login-password', 'password123');
    await page.fill('#login-confirm-password', 'different456');
    await page.click('#btn-login-submit');
    await expect(page.locator('#login-error')).not.toHaveClass(/hidden/);
    await expect(page.locator('#login-error')).toContainText('Passwords do not match');
  });

  test('sign-up mode shows error when fields are empty', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await page.click('#btn-login-switch');
    await page.click('#btn-login-submit');
    await expect(page.locator('#login-error')).not.toHaveClass(/hidden/);
    await expect(page.locator('#login-error')).toContainText('required');
  });

  test('clicking Sign in link from sign-up mode switches back to sign-in mode', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await page.click('#btn-login-switch');
    await expect(page.locator('#login-modal-title')).toContainText('Sign up');
    await page.click('#btn-login-switch');
    await expect(page.locator('#login-modal-title')).toContainText('Sign in');
    await expect(page.locator('#btn-login-submit')).toContainText('Sign in');
    await expect(page.locator('#login-confirm-password')).not.toBeVisible();
  });

  test('reopening login modal always starts in sign-in mode', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await page.click('#btn-login-switch');
    await expect(page.locator('#login-modal-title')).toContainText('Sign up');
    // Close login modal, then close options modal
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.click('#btn-options');
    await page.click('#btn-sign-in');
    await expect(page.locator('#login-modal-title')).toContainText('Sign in');
    await expect(page.locator('#login-confirm-password')).not.toBeVisible();
  });
});

test.describe('Mobile top spacing', () => {
  test('top padding of #app is small on mobile viewports', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForSelector('.bullet-row');
    const paddingTop = await page.locator('#app').evaluate(el =>
      parseFloat(getComputedStyle(el).paddingTop)
    );
    // On mobile (≤600px wide) the padding-top should be 8px, not the desktop 52px
    expect(paddingTop).toBe(8);
  });

  test('desktop top padding of #app is larger than mobile', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.reload();
    await page.waitForSelector('.bullet-row');
    const paddingTop = await page.locator('#app').evaluate(el =>
      parseFloat(getComputedStyle(el).paddingTop)
    );
    expect(paddingTop).toBeGreaterThan(8);
  });
});

test.describe('Escape to unfocus', () => {
  test('Escape while editing a bullet blurs it', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await expect(firstText).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(firstText).not.toBeFocused();
  });

  test('? shortcut opens shortcuts modal after Escape unfocuses bullet', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await page.keyboard.press('Escape');

    // Now no bullet is focused; ? should open shortcuts modal
    await page.keyboard.press('?');

    await expect(page.locator('#modal-shortcuts')).not.toHaveClass(/hidden/);
  });
});

test.describe('Zoom description Shift+Enter', () => {
  test('Shift+Enter from zoom description returns focus to zoom header', async ({ page }) => {
    const firstDot = page.locator('.bullet-dot').first();
    await firstDot.click();
    await expect(page.locator('#zoom-title')).toBeFocused();

    // Go to zoom description
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#zoom-desc')).toBeFocused();

    // Shift+Enter should return to zoom title
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#zoom-title')).toBeFocused();
  });
});

test.describe('Multi-select', () => {
  test('Shift+ArrowDown selects current and next bullet', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();

    await page.keyboard.press('Shift+ArrowDown');

    const selectedRows = page.locator('.bullet-row.selected');
    await expect(selectedRows).toHaveCount(2);
  });

  test('Shift+ArrowDown then Shift+ArrowDown extends selection to three', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');

    const selectedRows = page.locator('.bullet-row.selected');
    await expect(selectedRows).toHaveCount(3);
  });

  test('Shift+ArrowUp shrinks selection back toward anchor', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.bullet-row.selected')).toHaveCount(3);

    await page.keyboard.press('Shift+ArrowUp');
    await expect(page.locator('.bullet-row.selected')).toHaveCount(2);
  });

  test('regular ArrowDown clears selection', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();

    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.bullet-row.selected')).toHaveCount(2);

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.bullet-row.selected')).toHaveCount(0);
  });

  test('Tab indents all selected bullets', async ({ page }) => {
    // Get the first two bullets (both top-level siblings)
    const rows = page.locator('.bullet-row');
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();

    // Check initial margin of the 2nd row
    const secondRow = rows.nth(1);
    const marginBefore = await secondRow.evaluate(el => el.style.marginLeft);

    // Select first two bullets
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.bullet-row.selected')).toHaveCount(2);

    // Tab should indent — the first bullet is at index 0 (no previous sibling, skipped),
    // and the second bullet becomes a child of the first.
    await page.keyboard.press('Tab');

    const marginAfter = await secondRow.evaluate(el => el.style.marginLeft);
    expect(marginAfter).not.toBe(marginBefore);

    // The first row should remain at root level (unchanged margin)
    const firstRow = rows.first();
    const firstMarginAfter = await firstRow.evaluate(el => el.style.marginLeft);
    expect(firstMarginAfter).toBe('0px');
  });

  test('Alt+ArrowDown moves selection down', async ({ page }) => {
    // Use the first two top-level bullets; select them and move down
    const rows = page.locator('.bullet-row');
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();

    // Read the text of the first bullet and the bullet that would come after the selection
    const firstBulletText = await rows.nth(0).locator('.bullet-text').textContent();
    const thirdBulletText = await rows.nth(2).locator('.bullet-text').textContent();

    // Select first two bullets
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.bullet-row.selected')).toHaveCount(2);

    // Move selection down
    await page.keyboard.press('Alt+ArrowDown');

    // After move: the node that was 3rd should now be 1st
    const newFirstText = await rows.nth(0).locator('.bullet-text').textContent();
    expect(newFirstText).toBe(thirdBulletText);
  });
});

test.describe('Sync indicator', () => {
  test('sync indicator element exists in toolbar', async ({ page }) => {
    const indicator = page.locator('#sync-indicator');
    await expect(indicator).toBeAttached();
  });

  test('sync indicator is hidden by default (not signed in)', async ({ page }) => {
    const indicator = page.locator('#sync-indicator');
    // Should not have the 'visible' class when not signed in
    await expect(indicator).not.toHaveClass(/visible/);
  });

  test('sync indicator is inside the toolbar', async ({ page }) => {
    const toolbar = page.locator('#toolbar');
    const indicator = toolbar.locator('#sync-indicator');
    await expect(indicator).toBeAttached();
  });

  test('making a local change via edit shows pending indicator in toolbar', async ({ page }) => {
    // Initially the sync indicator should not be visible
    await expect(page.locator('#sync-indicator')).not.toHaveClass(/visible/);

    // Make an actual content edit: type into a bullet and blur
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await firstText.fill('Changed text');
    await firstText.blur();

    // saveDoc() is called on blur and sets syncStatus to 'pending', which adds .visible.pending
    const indicator = page.locator('#sync-indicator');
    await expect(indicator).toHaveClass(/visible/);
    await expect(indicator).toHaveClass(/pending/);
  });

  test('setSyncStatus drives indicator DOM classes via direct DOM manipulation', async ({ page }) => {
    // Verify the indicator responds correctly to class changes (CSS-only test)
    await page.evaluate(() => {
      const el = document.getElementById('sync-indicator');
      el.className = 'visible syncing';
      el.innerHTML = '<span class="sync-spinner"></span><span>Syncing\u2026</span>';
    });
    await expect(page.locator('#sync-indicator')).toHaveClass(/syncing/);
    await expect(page.locator('.sync-spinner')).toBeVisible();

    await page.evaluate(() => {
      const el = document.getElementById('sync-indicator');
      el.className = 'visible synced';
      el.innerHTML = '<span class="sync-dot"></span><span>Synced</span>';
    });
    await expect(page.locator('#sync-indicator')).toHaveClass(/synced/);

    await page.evaluate(() => {
      document.getElementById('sync-indicator').className = '';
    });
    await expect(page.locator('#sync-indicator')).not.toHaveClass(/visible/);
  });
});

test.describe('Conflict modal', () => {
  test('conflict modal element exists', async ({ page }) => {
    const modal = page.locator('#modal-conflict');
    await expect(modal).toBeAttached();
  });

  test('conflict modal is hidden by default', async ({ page }) => {
    const modal = page.locator('#modal-conflict');
    await expect(modal).toHaveClass(/hidden/);
  });

  test('conflict modal has local and remote textareas', async ({ page }) => {
    await expect(page.locator('#conflict-local')).toBeAttached();
    await expect(page.locator('#conflict-remote')).toBeAttached();
    await expect(page.locator('#conflict-resolved')).toBeAttached();
  });

  test('conflict modal has Keep Local, Use Server, and Apply Resolved buttons', async ({ page }) => {
    await expect(page.locator('#btn-conflict-use-local')).toBeAttached();
    await expect(page.locator('#btn-conflict-use-remote')).toBeAttached();
    await expect(page.locator('#btn-conflict-apply')).toBeAttached();
  });

  test('conflict modal can be opened and closed', async ({ page }) => {
    // Open modal programmatically
    await page.evaluate(() => {
      document.getElementById('modal-conflict').classList.remove('hidden');
    });
    const modal = page.locator('#modal-conflict');
    await expect(modal).not.toHaveClass(/hidden/);

    // Close via Escape key
    await page.keyboard.press('Escape');
    await expect(modal).toHaveClass(/hidden/);
  });

  test('Keep Local button closes conflict modal', async ({ page }) => {
    // Open conflict modal and populate fields
    await page.evaluate(() => {
      document.getElementById('conflict-local').value = '- Local item';
      document.getElementById('conflict-remote').value = '- Remote item';
      document.getElementById('conflict-resolved').value = '- Local item';
      document.getElementById('modal-conflict').classList.remove('hidden');
    });
    await expect(page.locator('#modal-conflict')).not.toHaveClass(/hidden/);

    // Click Keep Local – since no session, modal closes and status goes idle
    await page.locator('#btn-conflict-use-local').click();
    await expect(page.locator('#modal-conflict')).toHaveClass(/hidden/);
  });

  test('Use Server button closes modal and reverts to sync-synced state', async ({ page }) => {
    // Populate conflict modal with valid markdown content and open it
    await page.evaluate(() => {
      document.getElementById('conflict-local').value = '- Local item';
      document.getElementById('conflict-remote').value = '- Remote item';
      document.getElementById('conflict-resolved').value = '- Local item';
      document.getElementById('modal-conflict').classList.remove('hidden');
    });
    await expect(page.locator('#modal-conflict')).not.toHaveClass(/hidden/);

    // Click Use Server — without a real session, the handler still closes the modal
    // and updates lastSyncedVersion / pendingSync state in localStorage
    await page.locator('#btn-conflict-use-remote').click();
    await expect(page.locator('#modal-conflict')).toHaveClass(/hidden/);
  });

  test('Apply Resolved applies the resolved markdown to the outline', async ({ page }) => {
    const originalCount = await page.locator('.bullet-row').count();

    await page.evaluate(() => {
      document.getElementById('conflict-local').value = '- Item A';
      document.getElementById('conflict-remote').value = '- Item B';
      document.getElementById('conflict-resolved').value = '- Resolved Item';
      document.getElementById('modal-conflict').classList.remove('hidden');
    });

    await page.locator('#btn-conflict-apply').click();
    await expect(page.locator('#modal-conflict')).toHaveClass(/hidden/);

    // The outline should now contain the resolved content
    const rows = page.locator('.bullet-row');
    await expect(rows).toHaveCount(1);
    const firstText = page.locator('.bullet-text').first();
    await expect(firstText).toContainText('Resolved Item');
  });
});

test.describe('Cloud sync toggle', () => {
  test('Options modal contains a Cloud sync toggle button', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#btn-toggle-sync')).toBeVisible();
    await expect(page.locator('#btn-toggle-sync')).toContainText('Enable sync');
  });

  test('clicking Cloud sync toggle enables sync and updates button text', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#btn-toggle-sync')).toContainText('Enable sync');
    await page.click('#btn-toggle-sync');
    await expect(page.locator('#btn-toggle-sync')).toContainText('Disable sync');
  });

  test('clicking Cloud sync toggle again disables sync', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-sync');
    await expect(page.locator('#btn-toggle-sync')).toContainText('Disable sync');
    await page.click('#btn-toggle-sync');
    await expect(page.locator('#btn-toggle-sync')).toContainText('Enable sync');
  });

  test('sync enabled state persists after reload', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-sync');
    await expect(page.locator('#btn-toggle-sync')).toContainText('Disable sync');

    await page.reload();
    await page.waitForSelector('.bullet-row');
    await page.click('#btn-options');
    await expect(page.locator('#btn-toggle-sync')).toContainText('Disable sync');
  });

  test('sync is disabled by default (not enabled on fresh load)', async ({ page }) => {
    const syncEnabled = await page.evaluate(() => localStorage.getItem('sync_enabled'));
    // sync_enabled is either not set (null) or explicitly 'false' — never 'true' by default
    expect(syncEnabled === null || syncEnabled === 'false').toBe(true);
  });
});

test.describe('Developer mode', () => {
  test('Options modal contains a Developer mode toggle button', async ({ page }) => {
    await page.click('#btn-options');
    await expect(page.locator('#btn-toggle-dev')).toBeVisible();
    await expect(page.locator('#btn-toggle-dev')).toContainText('Enable dev mode');
  });

  test('dev panel is hidden by default', async ({ page }) => {
    await expect(page.locator('#dev-panel')).toHaveClass(/hidden/);
  });

  test('clicking Developer mode toggle shows the dev panel', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-dev');
    await expect(page.locator('#dev-panel')).not.toHaveClass(/hidden/);
    await expect(page.locator('#dev-panel')).toBeVisible();
  });

  test('dev panel shows debug information', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-dev');
    const panel = page.locator('#dev-panel');
    await expect(panel).toContainText('syncStatus');
    await expect(panel).toContainText('pendingSync');
    await expect(panel).toContainText('total nodes');
  });

  test('clicking Developer mode toggle again hides the dev panel', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-dev');
    await expect(page.locator('#dev-panel')).not.toHaveClass(/hidden/);
    await page.click('#btn-toggle-dev');
    await expect(page.locator('#dev-panel')).toHaveClass(/hidden/);
  });

  test('dev mode persists after reload', async ({ page }) => {
    await page.click('#btn-options');
    await page.click('#btn-toggle-dev');
    await expect(page.locator('#dev-panel')).not.toHaveClass(/hidden/);

    await page.reload();
    await page.waitForSelector('.bullet-row');
    await expect(page.locator('#dev-panel')).not.toHaveClass(/hidden/);
  });
});

test.describe('Persistence without login', () => {
  test('seed data is saved to localStorage on first load', async ({ page }) => {
    // After clearing localStorage and reloading (done by beforeEach), seed data is present
    const stored = await page.evaluate(() => localStorage.getItem('outline_v1'));
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored);
    expect(parsed.root.children.length).toBeGreaterThan(0);
  });

  test('edits made when not logged in persist after reload', async ({ page }) => {
    const firstText = page.locator('.bullet-text').first();
    await firstText.click();
    await firstText.fill('My persisted change');
    await firstText.blur();

    await page.reload();
    await page.waitForSelector('.bullet-row');

    await expect(page.locator('.bullet-text').first()).toContainText('My persisted change');
  });
});

test.describe('Splash screen', () => {
  test('splash element exists in the DOM', async ({ page }) => {
    await expect(page.locator('#splash')).toBeAttached();
  });

  test('splash is visible on first load (no prior localStorage)', async ({ page }) => {
    // beforeEach already cleared localStorage and reloaded; splash should be visible
    // (pointer-events: none so it doesn't block interaction)
    const splash = page.locator('#splash');
    await expect(splash).not.toHaveClass(/hidden/);
  });

  test('splash shows the app name', async ({ page }) => {
    await expect(page.locator('.splash-name')).toContainText('Virgulas');
  });

  test('splash shows the SVG logo mark', async ({ page }) => {
    await expect(page.locator('#splash .splash-logo')).toBeAttached();
  });

  test('splash auto-dismisses after a short time', async ({ page }) => {
    const splash = page.locator('#splash');
    // Auto-dismiss fires after ~800ms (delay) + 700ms (fade transition) = ~1500ms total
    await expect(splash).toHaveClass(/hidden/, { timeout: 3000 });
  });

  test('splash is hidden on subsequent loads (localStorage already populated)', async ({ page }) => {
    // Wait for splash to fully dismiss from first load
    await expect(page.locator('#splash')).toHaveClass(/hidden/, { timeout: 3000 });

    // Reload without clearing localStorage
    await page.reload();
    await page.waitForSelector('.bullet-row');

    // Splash should remain hidden immediately on subsequent load
    await expect(page.locator('#splash')).toHaveClass(/hidden/);
  });

  test('favicon links to icon.svg', async ({ page }) => {
    const faviconHref = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(faviconHref).toBe('icon.svg');
  });

  test('manifest link points to manifest.json', async ({ page }) => {
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBe('manifest.json');
  });
});

