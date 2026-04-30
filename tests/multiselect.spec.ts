import { test, expect } from './test';
import { setupDoc } from './test';

async function setupApp(page: import('@playwright/test').Page, nodeTexts = ['Node 1', 'Node 2', 'Node 3', 'Node 4']) {
  await setupDoc(page, {
    id: 'root', text: 'Root',
    children: nodeTexts.map((t, i) => ({ id: String(i + 1), text: t, children: [] }))
  });
}

async function setupWithChildren(page: import('@playwright/test').Page) {
  await setupDoc(page, {
    id: 'root', text: 'Root',
    children: [
      { id: '1', text: 'Node 1', children: [{ id: '1a', text: 'Child 1', children: [] }] },
      { id: '2', text: 'Node 2', children: [{ id: '2a', text: 'Child 2', children: [] }] }
    ]
  });
}

async function setupThreeParentsWithChildren(page: import('@playwright/test').Page) {
  await setupDoc(page, {
    id: 'root', text: 'Root',
    children: [
      { id: '1', text: 'Node 1', children: [{ id: '1a', text: 'Child 1', children: [] }] },
      { id: '2', text: 'Node 2', children: [{ id: '2a', text: 'Child 2', children: [] }] },
      { id: '3', text: 'Node 3', children: [{ id: '3a', text: 'Child 3', children: [] }] }
    ]
  });
}

test.describe('Multi-select', () => {
  test('Shift+Down selects two siblings', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(2);
  });

  test('Shift+Down multiple times extends selection', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(3);
  });

  test('Escape clears selection', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.node-selected')).toHaveCount(0);
  });

  test('Delete key removes selected nodes', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(1).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Delete');
    await expect(page.locator('.node-content')).toHaveCount(2);
    await expect(page.getByText('Node 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Node 4', { exact: true })).toBeVisible();
    await expect(page.getByText('Node 2', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Node 3', { exact: true })).toHaveCount(0);
  });

  test('Tab indents selected nodes under previous sibling', async ({ page }) => {
    await setupApp(page, ['Node 1', 'Node 2', 'Node 3']);
    await page.locator('.node-content').nth(1).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Tab');
    await expect(page.locator('.outliner > .node')).toHaveCount(1);
    await expect(page.locator('.outliner > .node > .children > .node')).toHaveCount(2);
    await expect(page.locator('.outliner > .node > .node-content')).toContainText('Node 1');
    await expect(page.locator('.outliner > .node > .children > .node').nth(0)).toContainText('Node 2');
    await expect(page.locator('.outliner > .node > .children > .node').nth(1).locator('input')).toHaveValue('Node 3');
  });

  test('Ctrl+Space toggles collapse for selected nodes', async ({ page }) => {
    await setupWithChildren(page);
    await expect(page.locator('.node-content')).toHaveCount(4);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+ ');
    await expect(page.locator('.node-content')).toHaveCount(2);
    await expect(page.getByText('Child 1', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Child 2', { exact: true })).toHaveCount(0);
  });

  test('Ctrl+Space expands all when all selected nodes are already collapsed', async ({ page }) => {
    await setupWithChildren(page);
    // Collapse both parents using the toggle button on each
    await page.locator('.node-content').nth(0).hover();
    await page.locator('.node-content').nth(0).locator('.collapse-toggle').click();
    await page.locator('.node-content').nth(1).hover();
    await page.locator('.node-content').nth(1).locator('.collapse-toggle').click();
    // Both children hidden — only 2 nodes visible
    await expect(page.locator('.node-content')).toHaveCount(2);

    // Select both collapsed parents
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');

    // Ctrl+Space with all collapsed → should expand both
    await page.keyboard.press('Control+ ');
    await expect(page.locator('.node-content')).toHaveCount(4);
    await expect(page.getByText('Child 1', { exact: true })).toBeVisible();
    await expect(page.getByText('Child 2', { exact: true })).toBeVisible();
  });

  test('Shift selection does not cross indentation levels', async ({ page }) => {
    await setupWithChildren(page);
    await page.locator('.node-content').nth(1).click(); // Child 1
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(0);
  });

  test('Deleting selected parent nodes also removes their children', async ({ page }) => {
    await setupThreeParentsWithChildren(page);

    await page.locator('.node-content').nth(0).click(); // Node 1
    await page.keyboard.press('Shift+ArrowDown'); // Node 1 + Node 2
    await page.keyboard.press('Delete');

    await expect(page.getByText('Node 1', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Child 1', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Node 2', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Child 2', { exact: true })).toHaveCount(0);
    await expect(page.locator('.node-content')).toHaveCount(2);
    await expect(page.getByText('Node 3', { exact: true })).toBeVisible();
    await expect(page.getByText('Child 3', { exact: true })).toBeVisible();
  });

  test('Alt+Up/Down moves selected block while preserving order', async ({ page }) => {
    await setupApp(page, ['Node 1', 'Node 2', 'Node 3', 'Node 4']);

    const topLevelIds = async () => {
      return await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.outliner > .node > .node-content'))
          .map((el) => el.getAttribute('data-node-id'));
      });
    };

    await page.locator('.node-content').nth(1).click();
    await page.keyboard.press('Shift+ArrowDown'); // select Node 2 + Node 3

    await page.keyboard.press('Alt+ArrowDown');
    expect(await topLevelIds()).toEqual(['1', '4', '2', '3']);

    await page.keyboard.press('Alt+ArrowUp');
    expect(await topLevelIds()).toEqual(['1', '2', '3', '4']);
  });
});
