import { test, expect } from './test';

test.describe('Raw Mode', () => {
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
          { id: '1', text: 'Item 1', children: [] },
          {
            id: '2', text: 'Item 2', children: [
              { id: '2.1', text: 'Child 2.1', children: [] }
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

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
  });

  test('Switch to Raw Mode and back', async ({ page }) => {
    // Check initial state
    const nodes = page.locator('.node-content');

    // Wait for render
    await expect(nodes.nth(0)).toBeVisible();
    await expect(nodes.nth(0)).toContainText('Item 1');

    // Click Raw button
    await page.getByRole('button', { name: 'Raw' }).click();

    // Check Raw Editor visible
    await expect(page.getByRole('heading', { name: 'Raw Editor' })).toBeVisible();

    // Check content
    const textarea = page.locator('textarea');
    const content = await textarea.inputValue();

    expect(content).toContain('- Item 1');
    expect(content).toContain('- Item 2');
    expect(content).toContain('  - Child 2.1'); // Check indentation (2 spaces)

    // Edit content
    await textarea.fill('- New Item\n  - New Child\n- Item 2');

    // Switch back
    await page.getByRole('button', { name: 'Back to Outline' }).click();

    // Verify changes
    // 0: New Item
    // 1: New Child
    // 2: Item 2

    await expect(nodes.nth(0)).toContainText('New Item');
    await expect(nodes.nth(1)).toContainText('New Child');
    await expect(nodes.nth(2)).toContainText('Item 2');

    // Check count
    await expect(nodes).toHaveCount(3);
  });

  test('Raw mode does not include //updated_at lines', async ({ page }) => {
    await page.getByRole('button', { name: 'Raw' }).click();
    const textarea = page.locator('textarea');
    const content = await textarea.inputValue();
    expect(content).not.toContain('// updated_at');
  });

  test('+ prefix in raw mode means collapsed node', async ({ page }) => {
    await page.getByRole('button', { name: 'Raw' }).click();
    const textarea = page.locator('textarea');

    // Use + to mark Item 2 as collapsed
    await textarea.fill('- Item 1\n+ Item 2\n  - Child 2.1');
    await page.getByRole('button', { name: 'Back to Outline' }).click();

    // Item 2 should be collapsed: Child 2.1 not visible
    await expect(page.locator('.node-content').nth(0)).toContainText('Item 1');
    await expect(page.locator('.node-content').nth(1)).toContainText('Item 2');
    // Child should not be visible because parent is collapsed
    await expect(page.locator('.node-content')).toHaveCount(2);
  });

  test('Escape characters in raw mode (\\+, \\-, \\\\)', async ({ page }) => {
    await page.getByRole('button', { name: 'Raw' }).click();
    const textarea = page.locator('textarea');

    // Use escape characters
    await textarea.fill('- Normal\n- \\+ not a bullet\n- \\- also not a bullet');
    await page.getByRole('button', { name: 'Back to Outline' }).click();

    // Three nodes
    await expect(page.locator('.node-content')).toHaveCount(3);
    await expect(page.locator('.node-content').nth(0)).toContainText('Normal');
    // Escaped + and - should appear as text (the escape prefix is kept as raw text)
    const text1 = await page.locator('.node-content').nth(1).innerText();
    expect(text1).toContain('+');
    const text2 = await page.locator('.node-content').nth(2).innerText();
    expect(text2).toContain('-');
  });
});
