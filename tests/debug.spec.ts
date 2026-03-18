import { test, expect } from './test';

test.describe('Debug mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);
      const doc = {
        id: 'root', text: 'Root',
        children: [{ id: '1', text: 'Node 1', children: [], collapsed: false }]
      };
      const encrypted = await window.App.crypto.encrypt(JSON.stringify(doc), key);
      localStorage.setItem('vmd_data', encrypted);
    });
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
  });

  test('debug panel not visible without ?debug=true', async ({ page }) => {
    await expect(page.locator('.debug-panel')).not.toBeVisible();
  });

  test('debug panel visible with ?debug=true', async ({ page }) => {
    await page.goto('/?debug=true');
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.debug-panel')).toBeVisible();
  });

  test('debug panel shows internal state', async ({ page }) => {
    await page.goto('/?debug=true');
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    const panel = page.locator('.debug-panel');
    await expect(panel).toContainText('focusPath');
    await expect(panel).toContainText('zoomPath');
    await expect(panel).toContainText('historyLength');
    await expect(panel).toContainText('nodeCount');
  });
});
