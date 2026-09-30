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

  test('▶/▼ control is revealed on hover on a pointer device', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);
    const toggle = parentNode.locator('.collapse-toggle');

    // A hover-capable device keeps the control hidden until the row is hovered.
    await expect(toggle).toHaveCSS('opacity', '0');

    await parentNode.hover();
    await expect(toggle).toHaveCSS('opacity', '1');

    // Hidden again once the pointer leaves.
    await page.mouse.move(0, 0);
    await expect(toggle).toHaveCSS('opacity', '0');
  });

  test('Bullet click zooms into node', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);
    const childNode = page.locator('.node-content').nth(1);

    await expect(childNode).toBeVisible();

    // Click bullet of Parent → should zoom in
    const bullet = parentNode.locator('.bullet').nth(0);
    await bullet.click();

    // After zooming into Parent, only Child is visible. Zooming focuses nothing,
    // so the child renders in read mode until `↓` steps into it.
    await expect(page.locator('.node-content')).toHaveCount(1);
    const zoomedChild = page.locator('.node-content').nth(0);
    await expect(zoomedChild).toContainText('Child');
    await expect(zoomedChild.locator('input')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(zoomedChild.locator('input')).toHaveValue('Child');

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

  test('Enter on a collapsed node creates a sibling, not a child', async ({ page }) => {
    const parentNode = page.locator('.node-content').nth(0);

    // Focus Parent and collapse it
    await parentNode.click();
    await expect(parentNode.locator('input')).toBeFocused();
    await page.keyboard.press('Control+ ');
    await expect(page.locator('.node-content')).toHaveCount(1);

    // Press Enter — should create a sibling, not a child
    await page.keyboard.press('Enter');

    // Now there should be 2 top-level nodes (Parent + new sibling), child still hidden
    await expect(page.locator('.node-content')).toHaveCount(2);

    // Expand parent — child should still be there (unchanged)
    await page.keyboard.press('Escape');
    await parentNode.hover();
    await parentNode.locator('.collapse-toggle').click();
    await expect(page.locator('.node-content')).toHaveCount(3);
  });
});

test.describe('Collapse/Expand — pointer detection', () => {
  test.use({ hasTouch: true });

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

  test('a real mouse move marks the shell and keeps the arrow hover-only', async ({ page }) => {
    // A hybrid device can report as touch-only (`any-hover: none`), so the
    // runtime pointer detection is what restores the desktop behaviour.
    await page.mouse.move(10, 10);
    await expect(page.locator('body')).toHaveClass(/detected-pointer-mouse/);

    const parentNode = page.locator('.node-content').nth(0);
    const toggle = parentNode.locator('.collapse-toggle');
    await expect(toggle).toHaveCSS('opacity', '0');
    await parentNode.hover();
    await expect(toggle).toHaveCSS('opacity', '1');
  });

  test('a touch-only device with no mouse keeps the arrow always visible', async ({ page }) => {
    // The setup click synthesises a mouse move; drop the class to model a
    // session that never sees one, then prove a `touch` pointer does not add it.
    await page.evaluate(() => document.body.classList.remove('detected-pointer-mouse'));
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', bubbles: true }));
    });
    await expect(page.locator('body')).not.toHaveClass(/detected-pointer-mouse/);

    const parentNode = page.locator('.node-content').nth(0);
    await expect(parentNode.locator('.collapse-toggle')).toHaveCSS('opacity', '1');
  });
});
