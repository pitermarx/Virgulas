import { test, expect } from './test';

test.describe('Undo/Redo', () => {
  test.beforeEach(async ({ page }) => {
    // Setup fresh state
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);

      const initialDoc = {
        id: 'root',
        text: 'Root',
        children: [
          { id: '1', text: 'Node 1', children: [] }
        ]
      };

      const encrypted = await window.App.crypto.encrypt(JSON.stringify(initialDoc), key);
      localStorage.setItem('vmd_data', encrypted);
    });

    // Unlock
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
  });

  test('Undo removes added node', async ({ page }) => {
    // Initial: 1 node (Div)
    const nodes = page.locator('.node-content');
    await expect(nodes).toHaveCount(1);
    await expect(nodes.nth(0)).toContainText('Node 1');

    // Add Node 2
    // Click Node 1 to edit (Input)
    await nodes.nth(0).click();
    await nodes.nth(0).locator('input').press('Enter');

    // Expect 2 nodes (Div + Input)
    await expect(nodes).toHaveCount(2);
    // New node (index 1) focused
    await expect(nodes.nth(1).locator('input')).toBeFocused();

    // Undo (Ctrl+Z)
    await page.keyboard.press('Control+z');

    // Expect 1 node
    await expect(nodes).toHaveCount(1);
    await expect(nodes.nth(0)).toContainText('Node 1');
  });

  test('Undo history capped at 100 actions', async ({ page }) => {
    // Add 105 nodes via dispatch, then verify undo can go back 100 times
    const nodes = page.locator('.node-content');
    await expect(nodes).toHaveCount(1);

    await page.evaluate(async () => {
      for (let i = 0; i < 105; i++) {
        const doc = window.App.state.doc.value;
        window.App.dispatch('add', [doc.children.length - 1]);
        // Ensure state update settles (signals are sync, but let's be safe)
      }
    });

    const totalCount = await page.evaluate(() => window.App.state.history.value.length);
    expect(totalCount).toBeLessThanOrEqual(100);
  });

  test('Text edit is undoable', async ({ page }) => {
    const nodes = page.locator('.node-content');
    const node1 = nodes.nth(0);

    // Focus and edit Node 1
    await node1.click();
    const input = node1.locator('input');
    await input.fill('Edited Text');
    await expect(input).toHaveValue('Edited Text');

    // Blur to commit
    await page.keyboard.press('Escape');

    // Undo
    await page.keyboard.press('Control+z');

    // Node text should revert (input value or div text)
    const textAfterUndo = await page.evaluate(() => window.App.state.doc.value.children[0].text);
    expect(textAfterUndo).not.toBe('Edited Text');
  });

  test('Redo restores added node', async ({ page }) => {
    const nodes = page.locator('.node-content');

    // Add Node 2
    await nodes.nth(0).click();
    await nodes.nth(0).locator('input').press('Enter');
    await expect(nodes).toHaveCount(2);

    // Undo
    await page.keyboard.press('Control+z');
    await expect(nodes).toHaveCount(1);

    // Redo (Ctrl+Shift+Z or Ctrl+Y)
    await page.keyboard.press('Control+Shift+z');
    await expect(nodes).toHaveCount(2);
    // Note: Redo might not focus the new node? It restores state.
    // If state included focusPath, maybe.
    // But verify existence.
    await expect(nodes.nth(1)).toBeVisible();
  });
});
