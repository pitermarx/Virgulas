import { test, expect } from './test';

test.describe('Search', () => {
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
          {
            id: '1', text: 'Parent Node', children: [
              { id: '1.1', text: 'Child Match', children: [] }
            ]
          },
          { id: '2', text: 'Unrelated Node', children: [] }
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

  test('Search filters nodes and makes read-only', async ({ page }) => {
    // Check initial state (Divs)
    const nodes = page.locator('.node-content');
    await expect(nodes).toHaveCount(3);
    await expect(nodes.nth(0)).toContainText('Parent Node');

    // Open search with Ctrl+F
    await page.keyboard.press('Control+f');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Match');

    // Expect: Parent (ancestor) and Child Match. Unrelated Node hidden.
    await expect(nodes).toHaveCount(2);

    await expect(nodes.nth(0)).toContainText('Parent Node');
    await expect(nodes.nth(1)).toContainText('Child Match');

    // Verify Read-Only (no inputs should appear even if clicked)
    // Click Parent Node
    await nodes.nth(0).click();

    // Should still be Div (no input) because readOnly prevents editing
    await expect(nodes.nth(0).locator('input')).toHaveCount(0);

    // Clear search
    await searchInput.fill('');

    // Expect all visible
    await expect(nodes).toHaveCount(3);

    // Click to edit should work now
    await nodes.nth(0).click();
    await expect(nodes.nth(0).locator('input')).toBeVisible();
  });

  test('Smart case: lowercase is case-insensitive, uppercase is case-sensitive', async ({ page }) => {
    // Open search with Ctrl+F
    await page.keyboard.press('Control+f');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    const nodes = page.locator('.node-content');

    // lowercase 'node' matches 'Parent Node' and 'Unrelated Node' (case-insensitive)
    await searchInput.fill('node');
    await expect(nodes).toHaveCount(2);

    // Uppercase 'Node' still matches since query has uppercase but text matches exactly
    await searchInput.fill('Node');
    await expect(nodes).toHaveCount(2);

    // Mixed case 'NODE' — no match since case-sensitive and text has 'Node' not 'NODE'
    await searchInput.fill('NODE');
    await expect(nodes).toHaveCount(0);
  });

  test('Result counter shows x/y during search', async ({ page }) => {
    // Open search with Ctrl+F
    await page.keyboard.press('Control+f');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();

    // Search for 'Node' — matches 'Parent Node' and 'Unrelated Node' (2 results)
    await searchInput.fill('Node');

    // Counter should show 1/2
    await expect(page.getByText('1/2')).toBeVisible();
  });

  test('Tab cycles through search results', async ({ page }) => {
    // Open search with Ctrl+F
    await page.keyboard.press('Control+f');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Node');

    // Initially at result 1/2
    await expect(page.getByText('1/2')).toBeVisible();

    // Press Tab -> advance to 2/2
    await page.keyboard.press('Tab');
    await expect(page.getByText('2/2')).toBeVisible();

    // Press Tab again -> wraps to 1/2
    await page.keyboard.press('Tab');
    await expect(page.getByText('1/2')).toBeVisible();

    // Press Shift+Tab -> goes back to 2/2
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByText('2/2')).toBeVisible();
  });

  test('Escape clears search', async ({ page }) => {
    // Open search with Ctrl+F
    await page.keyboard.press('Control+f');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    const nodes = page.locator('.node-content');
    await searchInput.fill('Match');
    await expect(nodes).toHaveCount(2);

    // Press Escape to clear search and close search bar
    await page.keyboard.press('Escape');
    await expect(nodes).toHaveCount(3);
    await expect(searchInput).not.toBeVisible();
  });
});
