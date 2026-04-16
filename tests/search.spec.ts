import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
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
    });
  });

  test('Search filters nodes and stays read-only until a result is activated', async ({ page }) => {
    // Check initial state (Divs)
    const nodes = page.locator('.node-content');
    await expect(nodes).toHaveCount(3);
    await expect(nodes.nth(0)).toContainText('Parent Node');

    // Open search with Escape (from no-focus state)
    await page.keyboard.press('Escape');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('Match');

    // Expect: Parent (ancestor) and Child Match. Unrelated Node hidden.
    await expect(nodes).toHaveCount(2);

    await expect(nodes.nth(0)).toContainText('Parent Node');
    await expect(nodes.nth(1)).toContainText('Child Match');

    // While searching, rendered results are read-only (no editable inputs).
    await expect(page.locator('.search-results input')).toHaveCount(0);

    // Exit search.
    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeVisible();

    // Expect all visible
    await expect(nodes).toHaveCount(3);

    // Click to edit should work now
    await nodes.nth(0).click();
    await expect(nodes.nth(0).locator('input')).toBeVisible();
  });

  test('Smart case: lowercase is case-insensitive, uppercase is case-sensitive', async ({ page }) => {
    // Open search with Escape (from no-focus state)
    await page.keyboard.press('Escape');
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
    // Open search with Escape (from no-focus state)
    await page.keyboard.press('Escape');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();

    // Search for 'Node' — matches 'Parent Node' and 'Unrelated Node' (2 results)
    await searchInput.fill('Node');

    // Counter should show 1/2
    await expect(page.getByText('1/2')).toBeVisible();
  });

  test('Tab cycles through search results', async ({ page }) => {
    // Open search with Escape (from no-focus state)
    await page.keyboard.press('Escape');
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

  test('Enter auto-zooms to the closest collapsed ancestor', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: '1', text: 'Parent Node', collapsed: true, children: [
            { id: '1.1', text: 'Child Match', children: [] }
          ]
        },
        { id: '2', text: 'Unrelated Node', children: [] }
      ]
    });

    await page.keyboard.press('Escape');
    const searchInput = page.getByPlaceholder('Search...');
    await searchInput.fill('Child Match');
    await page.keyboard.press('Enter');

    await expect(page.locator('.node-content')).toHaveCount(1);
    await expect(page.locator('.node-content').first().locator('input')).toHaveValue('Child Match');
    await expect(page).toHaveURL(/#1$/);
  });

  test('Clicking a search result auto-zooms to the closest collapsed ancestor', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: '1', text: 'Parent Node', collapsed: true, children: [
            { id: '1.1', text: 'Child Match', children: [] }
          ]
        },
        { id: '2', text: 'Unrelated Node', children: [] }
      ]
    });

    await page.keyboard.press('Escape');
    const searchInput = page.getByPlaceholder('Search...');
    await searchInput.fill('Child Match');
    await page.getByText('Child Match', { exact: true }).click();

    await expect(page.locator('.node-content')).toHaveCount(1);
    await expect(page.locator('.node-content').first().locator('input')).toHaveValue('Child Match');
    await expect(page).toHaveURL(/#1$/);
  });

  test('changing search query resets current highlighted match to the new result set', async ({ page }) => {
    await page.keyboard.press('Escape');
    const searchInput = page.getByPlaceholder('Search...');
    await searchInput.fill('Node');

    await page.keyboard.press('Tab');

    const selectedBeforeChange = await page.evaluate(async () => {
      const { currentSearchMatchId } = await import('/js/search.js');
      return currentSearchMatchId.value;
    });
    expect(selectedBeforeChange).toBe('2');

    await searchInput.fill('Child Match');

    const currentMatchId = await page.evaluate(async () => {
      const { currentSearchMatchId } = await import('/js/search.js');
      return currentSearchMatchId.value;
    });
    expect(currentMatchId).toBe('1.1');
  });

  test('getFirstClosedParent is null-safe for deleted or missing nodes', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { getFirstClosedParent } = await import('/js/search.js');
      return getFirstClosedParent('missing-node-id');
    });
    expect(result).toBeNull();
  });

  test('Escape toggles search closed', async ({ page }) => {
    // Open search with Escape (from no-focus state)
    await page.keyboard.press('Escape');
    const searchInput = page.getByPlaceholder('Search...');
    await expect(searchInput).toBeVisible();
    const nodes = page.locator('.node-content');
    await searchInput.fill('Match');
    await expect(nodes).toHaveCount(2);

    // Press Escape to close search bar
    await page.keyboard.press('Escape');
    await expect(nodes).toHaveCount(3);
    await expect(searchInput).not.toBeVisible();
  });
});
