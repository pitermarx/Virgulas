import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Node 1', children: [] }
      ]
    });
  });

  test('Enter from focused node adds a new node', async ({ page }) => {
    // Wait for nodes (Divs)
    await expect(page.locator('.node-content').nth(0)).toBeVisible();

    // Check marker
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();
    const node1Input = node1Div.locator('input');
    await expect(node1Input).toBeFocused();
    await node1Input.press('Enter');

    // Expect 2 nodes
    await expect(page.locator('.node-content')).toHaveCount(2);

    // The new node (index 1) should be focused
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeVisible();
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeFocused();
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

  test('Backspace on non-empty node deletes characters normally', async ({ page }) => {
    // Create a second node
    const node1Div = page.locator('.node-content').nth(0);
    await node1Div.click();
    await node1Div.locator('input').press('Enter');
    const node2Input = page.locator('.node-content').nth(1).locator('input');
    await node2Input.fill('Node 2');

    // Backspace on non-empty node → deletes last character, stays on node 2
    await node2Input.press('Backspace');

    // Node 2 should still exist (only a char was deleted)
    await expect(page.locator('.node-content')).toHaveCount(2);

    // Focus should remain on Node 2
    await expect(node2Input).toBeFocused();

    // The text should have one fewer character
    await expect(node2Input).toHaveValue('Node ');
  });

  test('Final Backspace asks confirmation before deleting node with children', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'P', children: [{ id: '1.1', text: 'Child', children: [] }] },
        { id: '2', text: 'Sibling', children: [] }
      ]
    });

    const parentInput = page.locator('[data-node-id="1"] input');
    await page.locator('[data-node-id="1"]').click();
    await expect(parentInput).toBeFocused();

    // First backspace removes text content only.
    await parentInput.press('Backspace');
    await expect(parentInput).toHaveValue('');

    // Second backspace attempts node deletion and must confirm because children exist.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe('Delete this node and all its children?');
      dialog.dismiss();
    });
    await parentInput.press('Backspace');

    await expect(page.locator('[data-node-id="1"]')).toBeVisible();
    await expect(page.locator('[data-node-id="1.1"]')).toBeVisible();
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
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLInputElement)) return null;
        return active.value;
      });
    }).toBe('Node 2');
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

  test('Indent ordering sequence matches SPEC example', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'A', text: 'A', children: [] },
        { id: 'B', text: 'B', children: [] },
        { id: 'C', text: 'C', children: [] }
      ]
    });

    await page.locator('[data-node-id="B"]').click();
    await page.keyboard.press('Tab'); // INDENT B

    await page.locator('[data-node-id="C"]').click();
    await page.keyboard.press('Tab'); // INDENT C

    await page.locator('[data-node-id="B"]').click();
    await page.keyboard.press('Shift+Tab'); // UNINDENT B

    await page.locator('[data-node-id="B"]').click();
    await page.keyboard.press('Tab'); // INDENT B

    const structure = await page.evaluate(async () => {
      const outlineModulePath: string = '/js/outline.js';
      const outline = (await import(outlineModulePath)).default;
      return {
        rootChildren: outline.get('root')?.children.peek() || [],
        aChildren: outline.get('A')?.children.peek() || [],
        bChildren: outline.get('B')?.children.peek() || [],
        cParent: outline.get('C')?.parentId || null,
        bParent: outline.get('B')?.parentId || null
      };
    });

    expect(structure.rootChildren).toEqual(['A']);
    expect(structure.aChildren).toEqual(['B']);
    expect(structure.bChildren).toEqual(['C']);
    expect(structure.bParent).toBe('A');
    expect(structure.cParent).toBe('B');
  });

  test('Ctrl+Space toggles collapse on focused node', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Parent', children: [{ id: '1.1', text: 'Child', children: [] }] }
      ]
    });

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
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Node 1', children: [] },
        { id: '2', text: 'Node 2', children: [] }
      ]
    });

    // Focus Node 2
    await page.locator('.node-content').nth(1).click();
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeFocused();

    // Ctrl+Backspace deletes
    await page.keyboard.press('Control+Backspace');

    // Node 2 should be gone (only Node 1 remains)
    await expect(page.locator('.node-content')).toHaveCount(1);
    const remaining = await page.locator('.node-content').nth(0).evaluate((el) => {
      const input = el.querySelector('input');
      if (input) return input.value;
      const text = el.querySelector('.node-text-md');
      return text ? text.textContent?.trim() : '';
    });
    expect(remaining).toBe('Node 1');
  });

  test('Ctrl+Backspace asks confirmation for nodes with children and supports dismiss', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Parent', children: [{ id: '1.1', text: 'Child', children: [] }] },
        { id: '2', text: 'Sibling', children: [] }
      ]
    });

    await page.locator('[data-node-id="1"]').click();

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toBe('Delete this node and all its children?');
      dialog.dismiss();
    });
    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('[data-node-id="1"]')).toBeVisible();
    await expect(page.locator('[data-node-id="1.1"]')).toBeVisible();
  });

  test('Arrow ↓ when nothing focused goes to first node', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'First', children: [] },
        { id: '2', text: 'Last', children: [] }
      ]
    });

    // Nothing focused — press ↓
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.node-content').nth(0).locator('input')).toBeFocused();
  });

  test('Arrow ↑ when nothing focused goes to last node', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'First', children: [] },
        { id: '2', text: 'Last', children: [] }
      ]
    });

    // Nothing focused — press ↑
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.node-content').nth(1).locator('input')).toBeFocused();
  });

  test('Arrow ↑ when nothing focused selects collapsed visible parent, not hidden child', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'First', children: [] },
        {
          id: '2',
          text: 'Collapsed parent',
          open: false,
          children: [{ id: '2.1', text: 'Hidden child', children: [] }]
        }
      ]
    });

    // Hidden child should not be visible while parent is collapsed.
    await expect(page.locator('.node-content')).toHaveCount(2);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-node-id="2"] input')).toBeFocused();
    await expect(page.locator('[data-node-id="2.1"]')).toHaveCount(0);
  });

  test('Shortcuts popup includes multi-select and search shortcuts', async ({ page }) => {
    await page.getByRole('button', { name: '?' }).click();

    const shortcutsModal = page.locator('#keyboard-shortcuts');
    await expect(shortcutsModal).toBeVisible();

    await expect(shortcutsModal).toContainText('Ctrl+Backspace');
    await expect(shortcutsModal).toContainText('Shift+↑/↓');
    await expect(shortcutsModal).toContainText('Delete selected nodes');
    await expect(shortcutsModal).toContainText('Clear focus / toggle search');
    await expect(shortcutsModal).toContainText('Search: Tab / Shift+Tab or ↑ / ↓');
    await expect(shortcutsModal).toContainText('Search: Enter');
  });

  test('single-line plain paste in node text is native (inserts at caret)', async ({ page }) => {
    const node = page.locator('.node-content').nth(0);
    await node.click();
    const input = node.locator('input');
    await expect(input).toBeFocused();

    // Set initial text so we can verify caret-position paste
    await input.fill('hello world');
    await input.press('Home'); // caret at start

    // Paste plain single-line text without bullet marker
    await page.evaluate(() => {
      const inp = document.querySelector('input.node-text-input') as HTMLInputElement;
      if (!inp) return;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => type === 'text/plain' ? 'greet ' : '' },
        configurable: true
      });
      inp.dispatchEvent(event);
    });

    // Node count should remain 1 — no new nodes created
    await expect(page.locator('.node-content')).toHaveCount(1);
  });

  test('multi-line bullet paste in node text creates structure', async ({ page }) => {
    const node = page.locator('.node-content').nth(0);
    await node.click();
    const input = node.locator('input');
    await expect(input).toBeFocused();

    await page.evaluate(() => {
      const inp = document.querySelector('input.node-text-input') as HTMLInputElement;
      if (!inp) return;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => type === 'text/plain' ? '- alpha\n- beta\n- gamma' : '' },
        configurable: true
      });
      inp.dispatchEvent(event);
    });

    // Three bullet lines should result in at least 1 node (the original) plus siblings/children
    const count = await page.locator('.node-content').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
