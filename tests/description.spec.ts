import { test, expect } from './test';

test.describe('Description', () => {
  test.beforeEach(async ({ page }) => {
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
          { id: '1', text: 'Node 1', description: 'Desc 1', children: [] }
        ]
      };

      const encrypted = await window.App.crypto.encrypt(JSON.stringify(initialDoc), key);
      localStorage.setItem('vmd_data', encrypted);
    });

    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
  });

  test('renders description', async ({ page }) => {
    const desc = page.locator('.node-description');
    await expect(desc).toBeVisible();
    await expect(desc).toContainText('Desc 1');
  });

  test('Shift+Enter toggles focus', async ({ page }) => {
    const node = page.locator('.node-content').first();
    await node.click();

    // Focus is on text input
    const textInput = node.locator('input').first();
    await expect(textInput).toBeFocused();

    // Shift+Enter -> Focus Description
    await textInput.press('Shift+Enter');

    const descInput = node.locator('textarea');
    await expect(descInput).toBeVisible();
    await expect(descInput).toBeFocused();

    // Shift+Enter -> Focus Text
    await descInput.press('Shift+Enter');
    await expect(textInput).toBeFocused();
  });

  test('description with more than 2 lines truncates to 2 lines with ellipsis', async ({ page }) => {
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = window.App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await window.App.crypto.deriveKey('password', salt);
      const doc = {
        id: 'root', text: 'Root',
        children: [{ id: '1', text: 'Node', description: 'Line 1\nLine 2\nLine 3', children: [] }]
      };
      const enc = await window.App.crypto.encrypt(JSON.stringify(doc), key);
      localStorage.setItem('vmd_data', enc);
    });
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();

    const descDiv = page.locator('.node-description div');
    await expect(descDiv).toBeVisible();
    const innerText = await descDiv.innerText();
    expect(innerText).toContain('Line 1');
    expect(innerText).toContain('Line 2');
    expect(innerText).not.toContain('Line 3');
    expect(innerText).toContain('\u2026'); // ellipsis character
  });

  test('description textarea grows to show all content', async ({ page }) => {
    const node = page.locator('.node-content').first();
    await node.click();
    const textInput = node.locator('input').first();
    await textInput.press('Shift+Enter');

    const descTextarea = node.locator('textarea');
    await expect(descTextarea).toBeFocused();

    const initialHeight = await descTextarea.evaluate(el => el.offsetHeight);

    // Type multiple lines
    await descTextarea.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

    const newHeight = await descTextarea.evaluate(el => el.offsetHeight);
    expect(newHeight).toBeGreaterThan(initialHeight);
  });

  test('focused node has distinct visual style from hover', async ({ page }) => {
    const node = page.locator('.node-content').first();

    // Click to focus
    await node.click();
    await expect(node).toHaveClass(/node-focused/);
  });
});
