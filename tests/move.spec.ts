import { test, expect } from './test';

test.describe('Move Nodes', () => {
  test.beforeEach(async ({ page }) => {
    // Setup fresh state with 3 nodes
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
          { id: '1', text: 'Node 1', children: [] },
          { id: '2', text: 'Node 2', children: [] },
          { id: '3', text: 'Node 3', children: [] }
        ]
      };
      
      const encrypted = await window.App.crypto.encrypt(JSON.stringify(initialDoc), key);
      localStorage.setItem('vmd_data', encrypted);
    });
    
    // Unlock
    await page.reload();
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    
    // Wait for render
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
  });

  test('Alt+Up moves node up', async ({ page }) => {
    // Initial check (all Divs)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 1');
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 2');
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 3');
    
    // Focus Node 2 (turns into Input)
    const n2Div = page.locator('.node-content').nth(1);
    await n2Div.click();
    const n2Input = n2Div.locator('input');
    await n2Input.focus();
    await expect(n2Input).toBeFocused();
    
    // Move Up
    await n2Input.press('Alt+ArrowUp');
    
    // Expect order: Node 2, Node 1, Node 3
    // Node 2 (Input - focused)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 2');
    await expect(page.locator('.node-content input').nth(0)).toBeFocused();
    
    // Node 1 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 1');
  });

  test('Alt+Down moves node down', async ({ page }) => {
    // Focus Node 2
    const n2Div = page.locator('.node-content').nth(1);
    await n2Div.click();
    const n2Input = n2Div.locator('input');
    await n2Input.focus();
    
    // Move Down
    await n2Input.press('Alt+ArrowDown');
    
    // Expect order: Node 1, Node 3, Node 2
    // Node 1 (Div)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 1');
    
    // Node 3 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 3');
    
    // Node 2 (Input - focused)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 2');
    await expect(page.locator('.node-content input').nth(0)).toBeFocused();
  });
});
