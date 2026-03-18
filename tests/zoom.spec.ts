import { test, expect } from './test';

test.describe('Zoom', () => {
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
            id: '1', text: 'Parent', children: [
              { id: '1.1', text: 'Child', children: [] }
            ]
          },
          { id: '2', text: 'Sibling', children: [] }
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

  test('Alt+Right zooms into node', async ({ page }) => {
    const nodes = page.locator('.node-content');
    // 1. Parent
    // 2. Child (visible because collapsed is undefined -> expanded)
    // 3. Sibling
    await expect(nodes).toHaveCount(3);

    const parent = nodes.nth(0);
    const child = nodes.nth(1);
    const sibling = nodes.nth(2);

    await expect(parent).toContainText('Parent');
    await expect(child).toContainText('Child');

    // Focus Parent (click to edit)
    await parent.click();
    const parentInput = parent.locator('input');
    await expect(parentInput).toBeVisible();
    await parentInput.focus();

    // Zoom In (Alt+Right)
    await page.keyboard.press('Alt+ArrowRight');

    // Expect:
    // Root is now Parent.
    // Displayed: Child.
    // Sibling should NOT be visible.

    await expect(nodes).toHaveCount(1);

    // Child is focused (input mode)
    const childInput = nodes.nth(0).locator('input');
    await expect(childInput).toBeVisible();
    await expect(childInput).toHaveValue('Child');
    await expect(childInput).toBeFocused();

    // Verify breadcrumbs
    const crumbs = page.locator('.breadcrumbs span');
    await expect(crumbs).toHaveCount(2); // Root > Parent
    await expect(crumbs.nth(1)).toHaveText('Parent');
  });

  test('Alt+Left zooms out', async ({ page }) => {
    // Zoom in first
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    const parentInput = parent.locator('input');
    await parentInput.focus();
    await page.keyboard.press('Alt+ArrowRight');

    // Verify zoomed
    await expect(page.locator('.node-content')).toHaveCount(1);

    // Zoom Out (Alt+Left)
    await page.keyboard.press('Alt+ArrowLeft');

    // Expect all visible
    await expect(page.locator('.node-content')).toHaveCount(3);

    // Verify focus is back on Parent (input mode)
    // Parent is first node
    const parentNode = page.locator('.node-content').nth(0);
    const input = parentNode.locator('input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('Click breadcrumb navigates', async ({ page }) => {
    // Zoom in
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    const parentInput = parent.locator('input');
    await parentInput.focus();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(1);

    // Click Root breadcrumb
    await page.locator('.breadcrumbs span').nth(0).click();

    // Expect all visible
    await expect(page.locator('.node-content')).toHaveCount(3);
  });

  test('URL carries node ID when zoomed', async ({ page }) => {
    // Zoom into Parent
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(1);

    // URL should contain ?node=<id>
    const url = page.url();
    expect(url).toContain('node=');
  });

  test('URL node parameter zooms on load', async ({ page }) => {
    // Get the ID of the Parent node
    const nodeId = await page.evaluate(() => window.App.state.doc.value.children[0].id);

    // Navigate to URL with node param
    await page.goto(`/?node=${nodeId}`);

    // Need to unlock again
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Should be zoomed into Parent
    await expect(page.locator('.node-content')).toHaveCount(1);
    await expect(page.locator('.node-content').nth(0)).toContainText('Child');
  });

  test('Invalid URL node param falls back to root', async ({ page }) => {
    await page.goto('/?node=nonexistent-id-xyz');
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Should show all nodes (root view)
    await expect(page.locator('.node-content')).toHaveCount(3);
  });

  test('zoomed node description is visible and editable with placeholder', async ({ page }) => {
    // Zoom into Parent (which has no description)
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(1);

    // Placeholder should be visible
    const descDisplay = page.locator('.zoom-desc-display');
    await expect(descDisplay).toBeVisible();
    await expect(descDisplay).toHaveClass(/zoom-desc-placeholder/);

    // Click to edit
    await descDisplay.click();
    const descTextarea = page.locator('.zoom-desc-textarea');
    await expect(descTextarea).toBeVisible();
    await expect(descTextarea).toBeFocused();

    // Type a description
    await descTextarea.fill('My zoom description');

    // Blur to exit editing
    await page.keyboard.press('Escape');

    // Description should now be shown (not placeholder)
    await expect(descDisplay).not.toHaveClass(/zoom-desc-placeholder/);
    await expect(descDisplay).toContainText('My zoom description');
  });

  test('zoomed node with no children shows empty state and allows creating node', async ({ page }) => {
    // Zoom into 'Sibling' (which has no children)
    const sibling = page.locator('.node-content').nth(2); // Sibling
    await sibling.click();
    await page.keyboard.press('Alt+ArrowRight');

    // Sibling has no children, so outliner should be empty
    await expect(page.locator('.node-content')).toHaveCount(0);

    // Empty state placeholder should be visible
    const emptyState = page.locator('.empty-state');
    await expect(emptyState).toBeVisible();

    // Click the empty state to create a new node
    await emptyState.click();

    // A new empty node should appear and be focused
    await expect(page.locator('.node-content')).toHaveCount(1);
    const newInput = page.locator('.node-content').first().locator('input');
    await expect(newInput).toBeVisible();
    await expect(newInput).toBeFocused();
  });

  test('pressing Enter in empty zoomed node creates first child', async ({ page }) => {
    // Zoom into 'Sibling' (which has no children)
    const sibling = page.locator('.node-content').nth(2);
    await sibling.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(0);

    // Press Enter with nothing focused (empty-state div receives focus via Tab or global handler)
    const emptyState = page.locator('.empty-state');
    await emptyState.focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('.node-content')).toHaveCount(1);
  });
});
