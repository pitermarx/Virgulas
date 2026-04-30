import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Zoom', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
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
    });
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
    await expect(page.locator('.node-content').nth(0)).toContainText('Parent');
    await expect(page.locator('[data-node-id="1.1"] input')).toHaveValue('Child');
    await expect(page.locator('.node-content').nth(2)).toContainText('Sibling');
  });

  test('URL carries node ID when zoomed', async ({ page }) => {
    // Zoom into Parent
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(1);

    await expect(page).toHaveURL(/#1$/);
    await expect(page.locator('.node-content').first().locator('input')).toHaveValue('Child');
    await expect(page.locator('.breadcrumbs span').nth(1)).toHaveText('Parent');
  });

  test('URL hash zooms on load', async ({ page }) => {
    // Get the ID of the Parent node from the rendered DOM
    const nodeId = await page.locator('.node-content').nth(0).getAttribute('data-node-id');
    if (!nodeId) {
      throw new Error('Expected parent node id in data-node-id');
    }

    // Navigate away first so the hash navigation triggers a full reload
    await page.goto('about:blank');
    await page.goto(`/#${nodeId}`);

    // Need to unlock again
    await page.locator('#auth-passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Should be zoomed into Parent
    await expect(page.locator('.node-content')).toHaveCount(1);
    await expect(page.locator('.node-content').nth(0)).toContainText('Child');
  });

  test('Invalid URL hash falls back to root', async ({ page }) => {
    await page.goto('about:blank');
    await page.goto('/#nonexistent-id-xyz');
    await page.locator('#auth-passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Should show all nodes (root view)
    await expect(page.locator('.node-content')).toHaveCount(3);
    await expect(page.locator('.node-content').nth(0)).toContainText('Parent');
    await expect(page.locator('.node-content').nth(1)).toContainText('Child');
    await expect(page.locator('.node-content').nth(2)).toContainText('Sibling');
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

  test('Enter in zoom description adds newline and does not create a node', async ({ page }) => {
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(1);

    const descDisplay = page.locator('.zoom-desc-display');
    await descDisplay.click();

    const descTextarea = page.locator('.zoom-desc-textarea');
    await expect(descTextarea).toBeFocused();

    await descTextarea.fill('Line 1');
    await descTextarea.press('Enter');
    await page.keyboard.type('Line 2');

    await expect(descTextarea).toHaveValue('Line 1\nLine 2');
    await expect(page.locator('.node-content')).toHaveCount(1);
  });

  test('Arrow boundaries in zoomed view blur and no-focus arrows return to first/last visible child', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: '1', text: 'Parent', children: [
            { id: '1.1', text: 'Child A', children: [] },
            { id: '1.2', text: 'Child B', children: [] }
          ]
        },
        { id: '2', text: 'Sibling', children: [] }
      ]
    });

    await page.locator('[data-node-id="1"]').click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.node-content')).toHaveCount(2);

    const firstChildInput = page.locator('[data-node-id="1.1"] input');
    const lastChildInput = page.locator('[data-node-id="1.2"] input');

    await expect(firstChildInput).toBeFocused();

    // ArrowUp on the first visible child should blur (not focus hidden parent).
    await firstChildInput.press('ArrowUp');
    await expect(page.locator('.node-content input')).toHaveCount(0);

    // With no focus, ArrowDown should focus first visible child.
    await page.keyboard.press('ArrowDown');
    await expect(firstChildInput).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(lastChildInput).toBeFocused();

    // ArrowDown on the last visible child should blur.
    await lastChildInput.press('ArrowDown');
    await expect(page.locator('.node-content input')).toHaveCount(0);

    // With no focus, ArrowUp should focus last visible child.
    await page.keyboard.press('ArrowUp');
    await expect(lastChildInput).toBeFocused();
  });

  test('Escape in zoom description exits edit mode and restores no-focus Arrow navigation', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: '1', text: 'Parent', children: [
            { id: '1.1', text: 'Child A', children: [] },
            { id: '1.2', text: 'Child B', children: [] }
          ]
        },
        { id: '2', text: 'Sibling', children: [] }
      ]
    });

    await page.locator('[data-node-id="1"]').click();
    await page.keyboard.press('Alt+ArrowRight');

    await page.locator('.zoom-desc-display').click();
    const descTextarea = page.locator('.zoom-desc-textarea');
    await expect(descTextarea).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('.zoom-desc-textarea')).toHaveCount(0);
    await expect(page.locator('.node-content input')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-node-id="1.1"] input')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('.node-content input')).toHaveCount(0);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-node-id="1.2"] input')).toBeFocused();
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

  test('breadcrumb text reacts when zoomed node text changes', async ({ page }) => {
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    await page.keyboard.press('Alt+ArrowRight');

    const activeBreadcrumb = page.locator('.breadcrumbs span').nth(1);
    await expect(activeBreadcrumb).toHaveText('Parent');

    await page.evaluate(async () => {
      const outline = (await import('/js/outline.js')).default;
      outline.update('1', { text: 'Parent Renamed' });
    });

    await expect(activeBreadcrumb).toHaveText('Parent Renamed');
  });

  test('zoomed node text is not directly editable', async ({ page }) => {
    const parent = page.locator('.node-content').nth(0);
    await parent.click();
    await page.keyboard.press('Alt+ArrowRight');

    await expect(page.locator('.breadcrumbs span').nth(1)).toHaveText('Parent');
    await expect(page.locator('input[value="Parent"]')).toHaveCount(0);
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
