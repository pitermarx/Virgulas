import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Developer panel', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root', text: 'Root',
      children: [{ id: '1', text: 'Node 1', children: [] }]
    });
  });

  test('dev panel not visible by default', async ({ page }) => {
    await expect(page.locator('.dev-panel')).not.toBeVisible();
  });

  test('?debug=true no longer activates dev panel', async ({ page }) => {
    await page.goto('/?debug=true');
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.dev-panel')).not.toBeVisible();
  });

  test('Ctrl+Alt+D shows dev panel', async ({ page }) => {
    await page.keyboard.press('Control+Alt+d');
    await expect(page.locator('.dev-panel')).toBeVisible();
  });

  test('Ctrl+Alt+D toggles dev panel off', async ({ page }) => {
    await page.keyboard.press('Control+Alt+d');
    await expect(page.locator('.dev-panel')).toBeVisible();
    await page.keyboard.press('Control+Alt+d');
    await expect(page.locator('.dev-panel')).not.toBeVisible();
  });

  test('dev panel shows diagnostics sections', async ({ page }) => {
    await page.keyboard.press('Control+Alt+d');
    const panel = page.locator('.dev-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('App');
    await expect(panel).toContainText('Outline');
    await expect(panel).toContainText('Sync');
    await expect(panel).toContainText('Crypto');
    await expect(panel).toContainText('Storage');
    await expect(panel).toContainText('Focus / Zoom / Search');
  });

  test('dev panel shows app version from meta tag', async ({ page }) => {
    const expectedVersion = await page.locator('meta[name="app-version"]').getAttribute('content');
    expect(expectedVersion).toBeTruthy();

    await page.keyboard.press('Control+Alt+d');
    await expect(page.locator('.dev-panel .dev-app-version')).toHaveText(expectedVersion || '');
  });

  test('dev panel close button hides panel', async ({ page }) => {
    await page.keyboard.press('Control+Alt+d');
    await expect(page.locator('.dev-panel')).toBeVisible();
    await page.locator('.dev-panel-close').click();
    await expect(page.locator('.dev-panel')).not.toBeVisible();
  });
});
