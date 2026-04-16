import { test, expect, setupDoc, moveNodeByPath } from './test';

test.describe('Drag and Drop', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Node 1', children: [] },
        {
          id: '2', text: 'Node 2', children: [
            { id: '2.1', text: 'Node 2.1', children: [] }
          ]
        },
        { id: '3', text: 'Node 3', children: [] }
      ]
    });
  });

  test('Move Node 1 to Node 3 (reorder)', async ({ page }) => {
    await moveNodeByPath(page, [0], [2]);

    // Result: Node 2, Node 2.1, Node 1 (Focused), Node 3

    // Node 2 (Div)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 2');

    // Node 2.1 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 2.1');

    // Node 1
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 1');

    // Node 3 (Div)
    await expect(page.locator('.node-content').nth(3)).toContainText('Node 3');
  });

  test('Move Node 3 to Node 1 (reorder up)', async ({ page }) => {
    await moveNodeByPath(page, [2], [0]);

    // Result: Node 3 (Focused), Node 1, Node 2

    // Node 3
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 3');

    // Node 1 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 1');

    // Node 2 (Div)
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 2');
  });

  test('Move Node 1 into Node 2 (reparent)', async ({ page }) => {
    await moveNodeByPath(page, [0], [1, 0]);

    // Result: Node 2, Node 1 (Focused), Node 2.1, Node 3

    // Node 2 (Div)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 2');

    // Node 1
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 1');

    // Node 2.1 (Div)
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 2.1');

    // Node 3 (Div)
    await expect(page.locator('.node-content').nth(3)).toContainText('Node 3');
  });
});
