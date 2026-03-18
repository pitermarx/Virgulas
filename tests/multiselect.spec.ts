import { test, expect } from './test';

async function setupApp(page, nodeTexts = ['Node 1', 'Node 2', 'Node 3', 'Node 4']) {
  await page.goto('/');
  await page.evaluate(async (texts) => {
    localStorage.clear();
    const salt = window.App.crypto.generateSalt();
    localStorage.setItem('vmd_salt', salt);
    const key = await window.App.crypto.deriveKey('password', salt);
    const doc = {
      id: 'root', text: 'Root',
      children: texts.map((t, i) => ({ id: String(i + 1), text: t, children: [], collapsed: false }))
    };
    const encrypted = await window.App.crypto.encrypt(JSON.stringify(doc), key);
    localStorage.setItem('vmd_data', encrypted);
  }, nodeTexts);
  await page.reload();
  await page.getByLabel('Passphrase').fill('password');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
}

async function setupWithChildren(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    const salt = window.App.crypto.generateSalt();
    localStorage.setItem('vmd_salt', salt);
    const key = await window.App.crypto.deriveKey('password', salt);
    const doc = {
      id: 'root', text: 'Root',
      children: [
        { id: '1', text: 'Node 1', children: [{ id: '1a', text: 'Child 1', children: [], collapsed: false }], collapsed: false },
        { id: '2', text: 'Node 2', children: [{ id: '2a', text: 'Child 2', children: [], collapsed: false }], collapsed: false }
      ]
    };
    const encrypted = await window.App.crypto.encrypt(JSON.stringify(doc), key);
    localStorage.setItem('vmd_data', encrypted);
  });
  await page.reload();
  await page.getByLabel('Passphrase').fill('password');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
}

test.describe('Multi-select', () => {
  test('Shift+Down selects two siblings', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(2);
  });

  test('Shift+Down multiple times extends selection', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(3);
  });

  test('Escape clears selection', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.node-selected')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.node-selected')).toHaveCount(0);
  });

  test('Delete key removes selected nodes', async ({ page }) => {
    await setupApp(page);
    await page.locator('.node-content').nth(1).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Delete');
    await expect(page.locator('.node-content')).toHaveCount(2);
  });

  test('Tab indents selected nodes under previous sibling', async ({ page }) => {
    await setupApp(page, ['Node 1', 'Node 2', 'Node 3']);
    await page.locator('.node-content').nth(1).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Tab');
    const children = await page.evaluate(() => window.App.state.doc.value.children[0].children.length);
    expect(children).toBe(2);
  });

  test('Ctrl+Space toggles collapse for selected nodes', async ({ page }) => {
    await setupWithChildren(page);
    await page.locator('.node-content').nth(0).click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+ ');
    const collapsed = await page.evaluate(() => {
      const doc = window.App.state.doc.value;
      return doc.children[0].collapsed && doc.children[1].collapsed;
    });
    expect(collapsed).toBe(true);
  });
});
