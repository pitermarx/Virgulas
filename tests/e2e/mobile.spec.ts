import { test, expect, type Page, setupDoc } from '../test';

/**
 * The mobile shell as one journey set: touch indentation, the mobile chrome
 * (search instead of shortcuts), tap-to-edit focus, and the viewport-aware
 * status bar.
 */
const MOBILE_CONTEXT = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
} as const;

test.describe('Mobile', () => {
    test.skip(({ browserName }) => browserName === 'firefox', 'Firefox does not support Playwright mobile contexts (isMobile).');
    test.use(MOBILE_CONTEXT);

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

    test('swipe right indents and swipe left outdents, without focusing the node', async ({ page }) => {
        // The mobile layout renders the document flat (the DOM does not nest child
        // nodes), so indentation is asserted through the visual x-offset: an
        // indented node renders 16px further right than its unindented origin.
        const flatX = await nodeX(page, 'B');
        await swipeNode(page, 'B', 120);
        await expect.poll(async () => (await nodeX(page, 'B')) ?? -1).toBeGreaterThan((flatX ?? 0) + 8);
        await expect(page.locator('[data-node-id="B"] input')).toHaveCount(0);

        await swipeNode(page, 'B', -120);
        await expect.poll(async () => (await nodeX(page, 'B')) ?? -1).toBe(flatX);
    });

    test('the mobile chrome offers search, not shortcuts, and a scroll gesture does not open it', async ({ page }) => {
        await expect(page.getByRole('button', { name: '?' })).toHaveCount(0);
        await expect(page.locator('.search-input')).toHaveCount(0);

        // A scroll gesture must not be mistaken for the search affordance.
        await swipeViewport(page, -160);
        await expect(page.locator('.search-input')).toHaveCount(0);

        await page.locator('.toolbar-btn-search').tap();
        const searchInput = page.locator('.search-input');
        await expect(searchInput).toBeVisible();
        await expect(searchInput).toBeFocused();
    });

    test('tapping between nodes keeps the edit focus stable', async ({ page }) => {
        await page.locator('[data-node-id="A"] .node-text-md').tap();
        await expect(page.locator('[data-node-id="A"] input')).toBeFocused();
        await expect.poll(() => activeNodeId(page)).toBe('A');
        await expectFocusedNodeStable(page, 'A');

        await page.locator('[data-node-id="B"] .node-text-md').tap();
        await expect(page.locator('[data-node-id="B"] input')).toBeFocused();
        await expect.poll(() => activeNodeId(page)).toBe('B');
        await expectFocusedNodeStable(page, 'B');
    });

    test('the status bar stays at the bottom of the visible viewport, above the keyboard, without overscroll', async ({ page }) => {
        const toolbar = page.locator('.status-toolbar');
        await expect(toolbar).toBeVisible();
        await expect(toolbar).toBeInViewport();

        // The shell sizes to the dynamic viewport, so the toolbar sits at the
        // bottom of what the user can actually see.
        const box = (await toolbar.boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
        expect((await page.locator('.main-view').boundingBox())!.height).toBeLessThanOrEqual(viewport.height + 1);

        // Simulate the visual viewport shrinking (keyboard appears).
        await page.evaluate(() => document.documentElement.style.setProperty('--keyboard-inset', '300px'));
        await expect(toolbar).toBeVisible();
        const paddingBottom = await toolbar.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom));
        expect(paddingBottom).toBeGreaterThan(0);
        await page.evaluate(() => document.documentElement.style.setProperty('--keyboard-inset', '0px'));

        const overscrollBehaviorY = await page.locator('.main-content').evaluate(el => getComputedStyle(el).overscrollBehaviorY);
        expect(overscrollBehaviorY).toBe('none');
    });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function nodeX(page: Page, nodeId: string): Promise<number | null> {
    return (await page.locator(`[data-node-id="${nodeId}"]`).boundingBox())?.x ?? null;
}

async function activeNodeId(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const activeEl = document.activeElement;
        return activeEl?.closest?.('.node-content')?.getAttribute('data-node-id') || null;
    });
}

async function expectFocusedNodeStable(page: Page, nodeId: string, durationMs = 260) {
    const stayedFocused = await page.evaluate(async ({ id, ms }) => {
        const deadline = performance.now() + ms;
        while (performance.now() < deadline) {
            const activeEl = document.activeElement;
            const activeNode = activeEl?.closest?.('.node-content')?.getAttribute('data-node-id') || null;
            if (activeNode !== id) return false;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return true;
    }, { id: nodeId, ms: durationMs });
    expect(stayedFocused).toBe(true);
}

async function swipeNode(page: Page, nodeId: string, deltaX: number, deltaY = 0) {
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    if (!box) throw new Error(`Could not resolve bounds for node ${nodeId}`);

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
    }, { startX: box.x + 28, startY: box.y + box.height / 2, endX: box.x + 28 + deltaX, endY: box.y + box.height / 2 + deltaY });
}

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
        const startTouches = makeTouchList(startX, startY);
        const endTouches = makeTouchList(startX + deltaX, startY + deltaY);
        dispatch('touchstart', startTouches, startTouches);
        dispatch('touchmove', endTouches, endTouches);
        dispatch('touchend', [], endTouches);
    }, { deltaY, deltaX });
}
