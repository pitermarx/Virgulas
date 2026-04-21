import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Description', () => {
  test.beforeEach(async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [
        { id: '1', text: 'Node 1', description: 'Desc 1', children: [] }
      ]
    });
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
    await setupDoc(page, {
      id: 'root', text: 'Root',
      children: [{ id: '1', text: 'Node', description: 'Line 1\nLine 2\nLine 3', children: [] }]
    });

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

  test('empty descriptions are invisible on desktop until description edit is requested', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Node 1', description: '', children: [] }]
    });

    const node = page.locator('.node-content').first();
    const description = node.locator('.node-desc-md');

    await expect(description).toHaveText('');
    await expect(description).not.toContainText('Add description...');

    await node.click();
    await expect(description).not.toContainText('Add description...');

    await node.locator('input').press('Shift+Enter');
    await expect(node.locator('textarea')).toBeVisible();
  });

  test('pasting bullet text into description does not create new nodes', async ({ page }) => {
    const node = page.locator('.node-content').first();
    await node.click();
    const textInput = node.locator('input').first();
    await textInput.press('Shift+Enter');

    const descTextarea = node.locator('textarea');
    await expect(descTextarea).toBeFocused();

    // Paste multi-line bullet text
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '- bullet one\n- bullet two');
      const ta = document.querySelector('textarea.node-desc-textarea') as HTMLTextAreaElement;
      if (ta) ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    });

    // Should remain as one node — no new nodes created
    await expect(page.locator('.node-content')).toHaveCount(1);
    // Description should contain the pasted text as-is
    const desc = await descTextarea.inputValue();
    expect(desc).toContain('bullet one');
    expect(desc).toContain('bullet two');
  });

  test('pasting plain text into description inserts inline text', async ({ page }) => {
    // Use a node with an empty description so the paste result is predictable
    await setupDoc(page, {
      id: 'root', text: 'Root',
      children: [{ id: '1', text: 'Node 1', description: '', children: [] }]
    });

    const node = page.locator('.node-content').first();
    await node.click();
    const textInput = node.locator('input').first();
    await textInput.press('Shift+Enter');

    const descTextarea = node.locator('textarea');
    await expect(descTextarea).toBeFocused();

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello world');
      const ta = document.querySelector('textarea.node-desc-textarea') as HTMLTextAreaElement;
      if (ta) ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    });

    const desc = await descTextarea.inputValue();
    expect(desc).toContain('hello world');
    // Node count unchanged
    await expect(page.locator('.node-content')).toHaveCount(1);
  });
});
