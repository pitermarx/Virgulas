import { test, expect, setupDoc } from '../test';

// docs/storage-interface.md §4.3: KeySession is the single retention point for
// the session passphrase. The lock-screen form holds it only while the user
// types; a successful unlock clears the field, so locking again must not
// prefill it (or leave the secret in the module for the rest of the session).

test('locking after an unlock never prefills the passphrase field', async ({ page }) => {
  await setupDoc(page, {
    id: 'root',
    text: 'Root',
    children: [{ id: 'after-lock', text: 'Unlocked document', children: [] }]
  }, 'correct-horse');

  await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();

  const input = page.locator('#auth-passphrase');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();
});
