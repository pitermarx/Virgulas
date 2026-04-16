import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Collapse/Expand', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        {
          id: '1', text: 'Parent', children: [
            { id: '1.1', text: 'Child', children: [] }
          ]
        }
      ]
    });
  });

  test('▶/▼ toggle button collapses and expands', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);
    const childNode = page.locator('.node-content').nth(1);

    await expect(parentNode).toContainText('Parent');
    await expect(childNode).toContainText('Child');
    await expect(childNode).toBeVisible();

    // Hover the parent node-content to reveal the collapse-toggle
    await parentNode.hover();
    const collapseToggle = parentNode.locator('.collapse-toggle').nth(0);
    await collapseToggle.click();

    // Child should now be hidden
    await expect(childNode).not.toBeVisible();

    // Hover and click collapse-toggle again to expand
    await parentNode.hover();
    await collapseToggle.click();
    await expect(childNode).toBeVisible();
  });

  test('Bullet click zooms into node', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);
    const childNode = page.locator('.node-content').nth(1);

    await expect(childNode).toBeVisible();

    // Click bullet of Parent → should zoom in
    const bullet = parentNode.locator('.bullet').nth(0);
    await bullet.click();

    // After zooming into Parent, only Child is visible (focused as input)
    await expect(page.locator('.node-content')).toHaveCount(1);
    const childInput = page.locator('.node-content').nth(0).locator('input');
    await expect(childInput).toBeVisible();
    await expect(childInput).toHaveValue('Child');

    // Breadcrumb should show path
    await expect(page.locator('.breadcrumbs')).toBeVisible();
  });

  test('Bullet indicator shows filled SVG when expanded and hollow SVG when collapsed', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);
    const bullet = parentNode.locator('.bullet');

    // Expanded: should show filled circle SVG (circle with fill="currentColor")
    await expect(bullet.locator('circle[fill="currentColor"]')).toBeVisible();

    // Collapse via toggle button (hover first to reveal it)
    await parentNode.hover();
    await parentNode.locator('.collapse-toggle').click();

    // Collapsed: should show hollow circle SVG (circle with fill="none")
    await expect(bullet.locator('circle[fill="none"]')).toBeVisible();
  });

  test('Ctrl+Space toggles collapse of focused node', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);
    const childNode = page.locator('.node-content').nth(1);

    // Focus Parent
    await parentNode.click();
    await expect(parentNode.locator('input')).toBeFocused();
    await expect(childNode).toBeVisible();

    // Ctrl+Space to collapse
    await page.keyboard.press('Control+ ');
    await expect(childNode).not.toBeVisible();

    // Ctrl+Space again to expand
    await page.keyboard.press('Control+ ');
    await expect(childNode).toBeVisible();
  });
});
