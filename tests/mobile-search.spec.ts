import { test, expect, type Page } from './test';
import { setupDoc } from './test';

test.describe('Mobile search gesture', () => {
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
                { id: 'B', text: 'Node B', children: [] },
                { id: 'C', text: 'Node C', children: [] }
            ]
        });
    });

    test('scroll-up gesture opens search once threshold is reached', async ({ page }) => {
        await expect(page.locator('.search-input')).toHaveCount(0);

        await swipeViewport(page, -150);

        const searchInput = page.locator('.search-input');
        await expect(searchInput).toBeVisible();
        await expect(searchInput).toBeFocused();
    });

    test('gesture filtering prevents accidental activation from short or wrong-direction swipes', async ({ page }) => {
        await swipeViewport(page, -26); // too short
        await expect(page.locator('.search-input')).toHaveCount(0);

        await swipeViewport(page, 150); // downward
        await expect(page.locator('.search-input')).toHaveCount(0);
    });

    test('scroll-up gesture does not activate search while editing a node', async ({ page }) => {
        await page.locator('[data-node-id="A"] .node-text-md').tap();
        const nodeInput = page.locator('[data-node-id="A"] input');
        await expect(nodeInput).toBeFocused();

        await swipeViewport(page, -160);

        await expect(nodeInput).toBeFocused();
        await expect(page.locator('.search-input')).toHaveCount(0);
    });
});

async function swipeViewport(page: Page, deltaY: number, deltaX = 0) {
    await page.evaluate(({ deltaY, deltaX }) => {
        const makeTouchList = (x: number, y: number) => ([{
            identifier: 1,
            clientX: x,
            clientY: y,
            pageX: x + window.scrollX,
            pageY: y + window.scrollY,
            screenX: x,
            screenY: y
        }]);

        const dispatch = (name: string, touches: Array<Record<string, number>>, changedTouches: Array<Record<string, number>>) => {
            const event = new Event(name, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: touches, configurable: true });
            Object.defineProperty(event, 'targetTouches', { value: touches, configurable: true });
            Object.defineProperty(event, 'changedTouches', { value: changedTouches, configurable: true });
            document.body.dispatchEvent(event);
        };

        const startX = Math.max(20, window.innerWidth / 2);
        const startY = Math.max(20, window.innerHeight * 0.75);
        const endX = startX + deltaX;
        const endY = startY + deltaY;

        const startTouches = makeTouchList(startX, startY);
        const endTouches = makeTouchList(endX, endY);

        dispatch('touchstart', startTouches, startTouches);
        dispatch('touchmove', endTouches, endTouches);
        dispatch('touchend', [], endTouches);
    }, { deltaY, deltaX });
}
