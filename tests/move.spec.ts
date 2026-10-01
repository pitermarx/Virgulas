import { test, expect, setupDoc, unlockApp } from './test';

test.describe('Move Nodes', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Node 1', children: [] },
        { id: '2', text: 'Node 2', children: [] },
        { id: '3', text: 'Node 3', children: [] }
      ]
    });
  });

  test('Alt+Up moves node up', async ({ page }) => {
    // Initial check (all Divs)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 1');
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 2');
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 3');

    // Focus Node 2 (turns into Input)
    const n2Div = page.locator('.node-content').nth(1);
    await n2Div.click();
    const n2Input = n2Div.locator('input');
    await n2Input.focus();
    await expect(n2Input).toBeFocused();

    // Move Up
    await n2Input.press('Alt+ArrowUp');

    // Expect order: Node 2, Node 1, Node 3
    // Node 2 (Input - focused)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 2');
    await expect(page.locator('.node-content input').nth(0)).toBeFocused();

    // Node 1 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 1');
  });

  test('Alt+Down moves node down', async ({ page }) => {
    // Focus Node 2
    const n2Div = page.locator('.node-content').nth(1);
    await n2Div.click();
    const n2Input = n2Div.locator('input');
    await n2Input.focus();

    // Move Down
    await n2Input.press('Alt+ArrowDown');

    // Expect order: Node 1, Node 3, Node 2
    // Node 1 (Div)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 1');

    // Node 3 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 3');

    // Node 2 (Input - focused)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 2');
    await expect(page.locator('.node-content input').nth(0)).toBeFocused();
  });

  test('top-level order survives reload after moving a node', async ({ page }) => {
    const originalCiphertext = await page.evaluate(() => localStorage.getItem('vmd_data_enc'));
    const node2 = page.locator('.node-content').nth(1);
    await node2.click();
    const input = node2.locator('input');
    await input.focus();
    await input.press('Alt+ArrowUp');

    await expect.poll(
      () => page.evaluate(() => localStorage.getItem('vmd_data_enc')),
      { timeout: 8000 }
    ).not.toBe(originalCiphertext);

    await page.reload();
    await unlockApp(page);
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 2');
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 1');
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 3');
  });
});
