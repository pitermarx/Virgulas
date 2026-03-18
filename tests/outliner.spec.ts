import { test, expect } from './test';

test.describe('Outliner', () => {
  test.beforeEach(async ({ page }) => {
    // Setup a fresh state with a known password
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);

      // Initial doc with some structure
      const initialDoc = {
        id: 'root',
        text: 'Root',
        children: [
          { id: '1', text: 'Node 1', children: [] },
          {
            id: '2', text: 'Node 2', children: [
              { id: '2.1', text: 'Node 2.1', children: [] }
            ]
          }
        ]
      };

      const encrypted = await window.App.crypto.encrypt(JSON.stringify(initialDoc), key);
      localStorage.setItem('vmd_data', encrypted);
    });

    // Unlock
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
  });

  test('renders nodes recursively', async ({ page }) => {
    // Check text content (Divs)
    const nodes = page.locator('.node-content');
    await expect(nodes).toHaveCount(3);

    await expect(nodes.nth(0)).toContainText('Node 1');
    await expect(nodes.nth(1)).toContainText('Node 2');
    await expect(nodes.nth(2)).toContainText('Node 2.1');
  });

  test('edits node text', async ({ page }) => {
    // Click Node 1 to edit (turns into Input)
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();

    const node1Input = node1Div.locator('input');
    await expect(node1Input).toBeVisible();

    await node1Input.press('End');
    await page.keyboard.type(' Edited');

    await expect(node1Input).toHaveValue('Node 1 Edited');

    // Verify persistence via internal state
    const doc = await page.evaluate(() => window.App.state.doc.value);
    expect(doc.children[0].text).toBe('Node 1 Edited');
  });

  test('deleting node with children asks for confirmation', async ({ page }) => {
    // Node 2 has children (Node 2.1)
    const node2 = page.locator('.node-content').nth(1);
    await node2.click();
    const node2Input = node2.locator('input');
    await expect(node2Input).toBeFocused();

    // Intercept the confirm dialog and accept
    page.once('dialog', dialog => dialog.accept());

    // Ctrl+Backspace to delete
    await page.keyboard.press('Control+Backspace');

    // Node 2 and its child should be gone (only Node 1 remains)
    await expect(page.locator('.node-content')).toHaveCount(1);
    const remaining = await page.evaluate(() => window.App.state.doc.value.children[0].text);
    expect(remaining).toBe('Node 1');
  });

  test('deleting node with children can be cancelled', async ({ page }) => {
    const node2 = page.locator('.node-content').nth(1);
    await node2.click();
    await expect(node2.locator('input')).toBeFocused();

    // Intercept and dismiss the dialog
    page.once('dialog', dialog => dialog.dismiss());

    await page.keyboard.press('Control+Backspace');

    // All nodes should still be present
    await expect(page.locator('.node-content')).toHaveCount(3);
  });
});
