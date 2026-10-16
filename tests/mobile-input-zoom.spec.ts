import { test, expect } from './test';
import { setupDoc } from './test';

// web-06: iOS Safari zooms the page to the focused control when its computed
// font size is below 16 px. On coarse-pointer devices every form control must
// therefore compute to at least 16 px (base.css, `@media (pointer: coarse)`).

test.describe('Mobile input font size (web-06)', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'Media-emulation behaviour is asserted in Chromium only.');

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
                {
                    id: 'B',
                    text: 'Node B',
                    description: 'Description of B',
                    children: []
                }
            ]
        });
        // The rule it asserts is scoped to `@media (pointer: coarse)`; fail fast
        // if the emulation does not produce a coarse pointer.
        expect(
            await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
        ).toBe(true);
    });

    async function focusFontSize(page: import('@playwright/test').Page, focus: () => Promise<void>): Promise<number> {
        await focus();
        return page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            const size = el ? parseFloat(getComputedStyle(el).fontSize) : 0;
            el?.blur();
            return size;
        });
    }

    test('nested node text computes at least 16 px', async ({ page }) => {
        const size = await focusFontSize(page, () =>
            page.locator('[data-node-id="A"] .node-text-md').click()
        );
        // Node A is a nested level (0.9rem = 14.4px) — exactly the case that
        // would zoom Safari without the clamp.
        expect(size).toBeGreaterThanOrEqual(16);
    });

    test('the description textarea computes at least 16 px', async ({ page }) => {
        await page.locator('[data-node-id="B"]').click();
        const size = await focusFontSize(page, () =>
            page.keyboard.press('Shift+Enter')
        );
        expect(size).toBeGreaterThanOrEqual(16);
    });

    test('the search field computes at least 16 px', async ({ page }) => {
        await page.locator('.toolbar-btn-search').tap();
        const size = await focusFontSize(page, () =>
            page.locator('.search-input').tap()
        );
        expect(size).toBeGreaterThanOrEqual(16);
    });
});
