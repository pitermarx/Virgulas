import { test, expect } from './test';
import { setupDoc } from './test';

test.describe('Mobile layout', () => {
    test.skip(({ browserName }) => browserName === 'firefox', 'Firefox does not support Playwright mobile contexts (isMobile).');

    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    });

    test.beforeEach(async ({ page }) => {
        await setupDoc(page, {
            id: 'root',
            text: 'Root',
            children: [
                { id: 'A', text: 'Node A', children: [] },
                { id: 'B', text: 'Node B', children: [] }
            ]
        });
    });

    // In a mobile browser the URL bar makes `100vh` taller than the visible
    // area, pushing the bottom status toolbar off-screen with no way to scroll
    // to it. The shell must size to the dynamic viewport so the toolbar lands
    // at the bottom of what the user can actually see.
    test('the status toolbar sits at the bottom of the visible viewport', async ({ page }) => {
        const toolbar = page.locator('.status-toolbar');
        await expect(toolbar).toBeVisible();
        await expect(toolbar).toBeInViewport();

        const box = (await toolbar.boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

        const mainView = (await page.locator('.main-view').boundingBox())!;
        expect(mainView.height).toBeLessThanOrEqual(viewport.height + 1);
    });
});
