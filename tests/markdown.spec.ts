import { test, expect } from './test';

test.describe('Markdown Rendering', () => {
  test.beforeEach(async ({ page }) => {
    // Setup fresh state with markdown content
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
          { id: '1', text: 'Normal Item', children: [] },
          { id: '2', text: '**Bold Item**', children: [] },
          { id: '3', text: '_Italic Item_', children: [] }
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

  test('Renders markdown when not focused', async ({ page }) => {
    // Check Bold Item
    // It should NOT be an input, but a div with strong tag
    // Wait, initially focus might be on first item? Or none?
    // FocusPath is null initially. So all should be rendered as markdown if they have text?
    // Code: showMarkdown = !isEditing && !readOnly && node.text;
    // Initial render: isEditing is false.
    // So all items should be markdown.
    
    // Check Item 2
    const boldNode = page.locator('strong', { hasText: 'Bold Item' });
    await expect(boldNode).toBeVisible();
    
    // Check Italic Item
    const italicNode = page.locator('em', { hasText: 'Italic Item' });
    await expect(italicNode).toBeVisible();
    
    // Check Normal Item
    // It should also be rendered as div, but no special tag. Just text.
    // Text: "Normal Item"
    const normalText = page.getByText('Normal Item', { exact: true });
    await expect(normalText).toBeVisible();
  });
  
  test('Switches to input on click', async ({ page }) => {
    // Bold Item is 2nd node (index 1)
    // Structure:
    // .node-content (Normal)
    // .node-content (Bold)
    // .node-content (Italic)
    
    const boldNodeWrapper = page.locator('.node-content').nth(1);
    
    // Click it
    await boldNodeWrapper.click();
    
    // Now it should be an input with value "**Bold Item**"
    const input = boldNodeWrapper.locator('input');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('**Bold Item**');
    
    // And strong tag should be gone
    await expect(boldNodeWrapper.locator('strong')).not.toBeVisible();
  });
  
  test('Switches back to markdown on blur', async ({ page }) => {
    const boldNodeWrapper = page.locator('.node-content').nth(1);
    const normalNodeWrapper = page.locator('.node-content').nth(0);
    
    // Click Bold Item to edit
    await boldNodeWrapper.click();
    await expect(boldNodeWrapper.locator('input')).toBeVisible();
    
    // Click Normal Item to move focus
    await normalNodeWrapper.click();
    
    // Bold Item should be markdown again
    await expect(boldNodeWrapper.locator('strong')).toBeVisible();
    
    // Normal Item should be input
    const normalInput = normalNodeWrapper.locator('input');
    await expect(normalInput).toBeVisible();
  });
});
