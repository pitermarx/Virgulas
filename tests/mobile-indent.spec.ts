import { test, expect, type Page } from './test';
import { setupDoc } from './test';

test.describe('Mobile swipe indentation', () => {
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

    test('swipe right indents and swipe left outdents', async ({ page }) => {
        await swipeNode(page, 'B', 120);
        await expect.poll(() => getParentId(page, 'B')).toBe('A');

        await swipeNode(page, 'B', -120);
        await expect.poll(() => getParentId(page, 'B')).toBe('root');
    });

    test('swipe does not focus the swiped node', async ({ page }) => {
        // Swipe node B to indent it
        await swipeNode(page, 'B', 120);
        await expect.poll(() => getParentId(page, 'B')).toBe('A');

        // Node B should not be focused (no input visible inside node B)
        const nodeBInput = page.locator('[data-node-id="B"] input');
        await expect(nodeBInput).toHaveCount(0);
    });

    test('? shortcuts button is not visible on mobile', async ({ page }) => {
        await expect(page.getByRole('button', { name: '?' })).toHaveCount(0);
    });
});

async function getParentId(page: Page, nodeId: string): Promise<string | null> {
    return page.evaluate(async ({ id }) => {
        const outline = (await import('/js/outline.js')).default;
        const node = outline.get(id);
        return node ? node.parentId : null;
    }, { id: nodeId });
}

async function swipeNode(page: Page, nodeId: string, deltaX: number, deltaY = 0) {
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await expect(node).toBeVisible();

    const box = await node.boundingBox();
    if (!box) {
        throw new Error(`Could not resolve bounds for node ${nodeId}`);
    }

    const startX = box.x + 28;
    const startY = box.y + box.height / 2;
    const endX = startX + deltaX;
    const endY = startY + deltaY;

    await node.evaluate((el, coords) => {
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
            el.dispatchEvent(event);
        };

        const startTouches = makeTouchList(coords.startX, coords.startY);
        const endTouches = makeTouchList(coords.endX, coords.endY);

        dispatch('touchstart', startTouches, startTouches);
        dispatch('touchmove', endTouches, endTouches);
        dispatch('touchend', [], endTouches);
    }, { startX, startY, endX, endY });
}
