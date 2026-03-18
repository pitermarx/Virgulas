import { test, expect } from './test';

test('app shell and splash screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Virgulas');

  const splash = page.locator('#splash');
  await expect(splash).toBeVisible();
  await expect(splash).toHaveText(/Virgulas/);

  await expect(splash).toBeHidden({ timeout: 5000 });
  
  const app = page.locator('#app');
  await expect(app).toBeVisible();
  await expect(page.getByText('Welcome to Virgulas')).toBeVisible();
});
