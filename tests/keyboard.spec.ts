import { test, expect } from './test';

test.describe('Keyboard', () => {
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
  });

  test('manual dispatch adds node', async ({ page }) => {
    // Wait for nodes (Divs)
    await expect(page.locator('.node-content').nth(0)).toBeVisible();

    // Check marker
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Manually dispatch add action for path [0]
    await page.evaluate(() => {
      if (typeof window.App.dispatch !== 'function') throw new Error('dispatch is not a function');
      window.App.dispatch('add', [0]);
    });

    // Expect 2 nodes
    await expect(page.locator('.node-content')).toHaveCount(2);

    // The new node (index 1) should be focused (Input)
    await expect(page.locator('.node-content input').nth(0)).toBeVisible(); // Only 1 input
    await expect(page.locator('.node-content input').nth(0)).toBeFocused();
  });

  test('Enter creates new sibling node', async ({ page }) => {
    // Click Node 1 to edit (turns into Input)
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();

    const node1Input = node1Div.locator('input');
    await expect(node1Input).toBeVisible();
    await expect(node1Input).toBeFocused();

    // Use locator.press which ensures focus
    await node1Input.press('Enter');

    // Expect 2 nodes total
    await expect(page.locator('.node-content')).toHaveCount(2);

    // Expect focus on new node (Index 1) which is now an Input
    // Node 1 should be a Div (unfocused)
    await expect(page.locator('.node-content').nth(0).locator('input')).toHaveCount(0);

    const newNodeInput = page.locator('.node-content').nth(1).locator('input');
    await expect(newNodeInput).toBeVisible();
    await expect(newNodeInput).toBeFocused();
    await expect(newNodeInput).toHaveValue('');
  });

  test('Backspace deletes empty node', async ({ page }) => {
    // Create empty node first
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();
    const node1Input = node1Div.locator('input');
    await node1Input.press('Enter');

    // Verify created
    await expect(page.locator('.node-content')).toHaveCount(2);

    const newNodeInput = page.locator('.node-content').nth(1).locator('input');
    await expect(newNodeInput).toBeFocused();

    // Backspace on empty node (new node is focused)
    await newNodeInput.press('Backspace');

    // Expect deleted and focus back on Node 1 (becomes Input)
    await expect(page.locator('.node-content')).toHaveCount(1);
    await expect(node1Input).toBeFocused();
  });

  test('Backspace at start of non-empty node focuses previous', async ({ page }) => {    // Create a second node
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();
    await node1Div.locator('input').press('Enter');
    const node2Input = page.locator('.node-content').nth(1).locator('input');
    await node2Input.fill('Node 2');

    // Move cursor to beginning
    await node2Input.press('Home');
    // Backspace at start of non-empty node → should focus Node 1 (not delete)
    await node2Input.press('Backspace');

    // Node 2 should still exist
    await expect(page.locator('.node-content')).toHaveCount(2);

    // Focus should be on Node 1
    const node1Input = page.locator('.node-content').nth(0).locator('input');
    await expect(node1Input).toBeFocused();
  });

  test('Arrow keys navigate nodes', async ({ page }) => {
    // Setup: Root -> Node 1 -> Node 2
    // Create Node 2 via Enter
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();
    await node1Div.locator('input').press('Enter');

    const node2Input = page.locator('.node-content').nth(1).locator('input');
    await expect(node2Input).toBeFocused();

    // Type text so it's not empty (empty nodes always show as input)
    await node2Input.fill('Node 2');

    // Arrow Up -> Focus Node 1 (turns into Input, Node 2 becomes Div)
    await node2Input.press('ArrowUp');

    const node1Input = node1Div.locator('input');
    await expect(node1Input).toBeFocused();
    await expect(page.locator('.node-content').nth(1).locator('input')).toHaveCount(0);

    // Arrow Down -> Focus Node 2
    await node1Input.press('ArrowDown');
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeFocused();
  });

  test('Tab indents/unindents nodes', async ({ page }) => {
    // Setup: Node 1 -> Node 2
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();
    await node1Div.locator('input').press('Enter');

    const node2Input = page.locator('.node-content').nth(1).locator('input');
    await expect(node2Input).toBeFocused();

    // Indent Node 2 (becomes child of Node 1)
    await node2Input.press('Tab');

    // Structure: Node 1 -> [Node 2]
    // Node 1 (Div)
    //   Node 2 (Input - focused)

    // Note: Structure changed. Node 2 is now inside Node 1's children div.
    // Selector: .node (Node 1) > .children > .node (Node 2) > .node-content > input

    const nestedInput = page.locator('.node .children .node .node-content input');
    await expect(nestedInput).toBeVisible();
    await expect(nestedInput).toBeFocused();

    // Unindent Node 2 (becomes sibling of Node 1)
    await nestedInput.press('Shift+Tab');

    // Structure: Node 1, Node 2
    await expect(page.locator('.node > .node-content')).toHaveCount(2);

    const siblingNode2Input = page.locator('.node-content').nth(1).locator('input');
    await expect(siblingNode2Input).toBeVisible();
    await expect(siblingNode2Input).toBeFocused();
  });

  test('Ctrl+Space toggles collapse on focused node', async ({ page }) => {
    // Setup a node with children
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);
      const doc = {
        id: 'root', text: 'Root',
        children: [
          { id: '1', text: 'Parent', children: [{ id: '1.1', text: 'Child', children: [] }] }
        ]
      };
      localStorage.setItem('vmd_data', await window.App.crypto.encrypt(JSON.stringify(doc), key));
    });
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Focus Parent
    await page.locator('.node-content').nth(0).click();
    await expect(page.locator('.node-content').nth(0).locator('input')).toBeFocused();

    // Child is visible
    await expect(page.locator('.node-content').nth(1)).toBeVisible();

    // Ctrl+Space collapses
    await page.keyboard.press('Control+ ');
    await expect(page.locator('.node-content')).toHaveCount(1);

    // Ctrl+Space expands again
    await page.keyboard.press('Control+ ');
    await expect(page.locator('.node-content')).toHaveCount(2);
  });

  test('Ctrl+Backspace deletes focused node', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);
      const doc = {
        id: 'root', text: 'Root',
        children: [
          { id: '1', text: 'Node 1', children: [] },
          { id: '2', text: 'Node 2', children: [] }
        ]
      };
      localStorage.setItem('vmd_data', await window.App.crypto.encrypt(JSON.stringify(doc), key));
    });
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Focus Node 2
    await page.locator('.node-content').nth(1).click();
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeFocused();

    // Ctrl+Backspace deletes
    await page.keyboard.press('Control+Backspace');

    // Node 2 and its child should be gone (only Node 1 remains)
    await expect(page.locator('.node-content')).toHaveCount(1);
    // Node 1 may be focused as input after delete
    const remaining = await page.evaluate(() => window.App.state.doc.value.children[0].text);
    expect(remaining).toBe('Node 1');
  });

  test('Arrow ↓ when nothing focused goes to first node', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);
      const doc = {
        id: 'root', text: 'Root',
        children: [
          { id: '1', text: 'First', children: [] },
          { id: '2', text: 'Last', children: [] }
        ]
      };
      localStorage.setItem('vmd_data', await window.App.crypto.encrypt(JSON.stringify(doc), key));
    });
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Nothing focused — press ↓
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.node-content').nth(0).locator('input')).toBeFocused();
  });

  test('Arrow ↑ when nothing focused goes to last node', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);
      const doc = {
        id: 'root', text: 'Root',
        children: [
          { id: '1', text: 'First', children: [] },
          { id: '2', text: 'Last', children: [] }
        ]
      };
      localStorage.setItem('vmd_data', await window.App.crypto.encrypt(JSON.stringify(doc), key));
    });
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Nothing focused — press ↑
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeFocused();
  });
});
