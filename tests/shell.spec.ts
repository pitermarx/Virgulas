import { test, expect } from './test';

test('app shell and splash screen — first visit uses memory mode', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Virgulas');

  const splash = page.locator('#splash');
  await expect(splash).toBeVisible();
  await expect(splash).toHaveText(/Virgulas/);

  await expect(splash).toBeHidden({ timeout: 5000 });

  const app = page.locator('#app');
  await expect(app).toBeVisible();

  // First-ever visit: memory mode — no lock screen, app renders directly
  await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
  await expect(page.getByText('Unlock Virgulas')).not.toBeVisible();
});

test('app shell shows lock screen when a storage mode is remembered', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('vmd_last_mode', 'local');
  });
  await page.goto('/');
  await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
  await expect(page.getByText('Unlock Virgulas')).toBeVisible();
});
