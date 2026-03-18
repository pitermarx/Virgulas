import { test, expect } from './test';

test.describe('Drag and Drop', () => {
  test.beforeEach(async ({ page }) => {
    // Setup fresh state
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
          { id: '2', text: 'Node 2', children: [
             { id: '2.1', text: 'Node 2.1', children: [] }
          ]},
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
    
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
  });

  test('Move Node 1 to Node 3 (reorder)', async ({ page }) => {
    // Dispatch move action
    // From: [0] (Node 1)
    // To: [2] (Node 3)
    
    await page.evaluate(() => {
       window.App.dispatch('move', [0], [2]);
    });
    
    // Result: Node 2, Node 2.1, Node 1 (Focused), Node 3
    
    // Node 2 (Div)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 2');
    
    // Node 2.1 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 2.1');
    
    // Node 1 (Input - focused because moved)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 1');
    
    // Node 3 (Div)
    await expect(page.locator('.node-content').nth(3)).toContainText('Node 3');
  });
  
  test('Move Node 3 to Node 1 (reorder up)', async ({ page }) => {
    // From: [2] (Node 3)
    // To: [0] (Node 1)
    
    await page.evaluate(() => {
       window.App.dispatch('move', [2], [0]);
    });
    
    // Result: Node 3 (Focused), Node 1, Node 2
    
    // Node 3 (Input - focused)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 3');
    
    // Node 1 (Div)
    await expect(page.locator('.node-content').nth(1)).toContainText('Node 1');
    
    // Node 2 (Div)
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 2');
  });
  
  test('Move Node 1 into Node 2 (reparent)', async ({ page }) => {
    // From: [0] (Node 1)
    // To: [1, 0] (Node 2.1)
    
    await page.evaluate(() => {
       window.App.dispatch('move', [0], [1, 0]);
    });
    
    // Result: Node 2, Node 1 (Focused), Node 2.1, Node 3
    
    // Node 2 (Div)
    await expect(page.locator('.node-content').nth(0)).toContainText('Node 2');
    
    // Node 1 (Input - focused)
    await expect(page.locator('.node-content input').nth(0)).toHaveValue('Node 1');
    
    // Node 2.1 (Div)
    await expect(page.locator('.node-content').nth(2)).toContainText('Node 2.1');
    
    // Node 3 (Div)
    await expect(page.locator('.node-content').nth(3)).toContainText('Node 3');
  });
});
