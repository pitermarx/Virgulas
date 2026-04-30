import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Zoom browser history', () => {
    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                {
                    id: '1',
                    text: 'Parent',
                    children: [
                        { id: '1.1', text: 'Child', children: [] }
                    ]
                },
                { id: '2', text: 'Sibling', children: [] }
            ]
        });
    });

    test('browser back and forward restore zoom state from URL hash history', async ({ page }) => {
        await page.locator('[data-node-id="1"] .node-text-md').click();
        await page.keyboard.press('Alt+ArrowRight');

        await expect(page).toHaveURL(/#1$/);
        await expect(page.locator('.node-content')).toHaveCount(1);
        await expect(page.locator('[data-node-id="1.1"]')).toBeVisible();

        await page.keyboard.press('Alt+ArrowRight');

        await expect(page).toHaveURL(/#1\.1$/);
        await expect(page.locator('.empty-state')).toBeVisible();

        await page.goBack();
        await expect(page).toHaveURL(/#1$/);
        await expect(page.locator('.node-content')).toHaveCount(1);
        await expect(page.locator('[data-node-id="1.1"]')).toBeVisible();

        await page.goBack();
        await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
        await expect(page.locator('.node-content')).toHaveCount(3);
        await expect(page.locator('.node-content').nth(0)).toContainText('Parent');
        await expect(page.locator('[data-node-id="1.1"] input')).toHaveValue('Child');
        await expect(page.locator('.node-content').nth(2)).toContainText('Sibling');

        await page.goForward();
        await expect(page).toHaveURL(/#1$/);
        await expect(page.locator('.node-content')).toHaveCount(1);
    });
});