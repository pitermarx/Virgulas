import { test, expect } from './test';

test.describe('Unit harness', () => {
    test('@unit source/test.html suites pass', async ({ page }) => {
        await page.goto('/test.html');

        await expect(page.locator('#summary')).toHaveClass(/ready/, { timeout: 120_000 });

        await expect
            .poll(
                async () => {
                    return await page.evaluate(() => {
                        const metaTexts = Array.from(document.querySelectorAll('.tab-meta'))
                            .map((el) => el.textContent || '');

                        if (metaTexts.length === 0) return 'waiting';

                        let runningTotal = 0;
                        let failedTotal = 0;

                        for (const text of metaTexts) {
                            const runningMatch = text.match(/\|\s*(\d+)\s+running\s*\|/i);
                            const failedMatch = text.match(/\|\s*(\d+)\s+failed\s*$/i);

                            if (!runningMatch || !failedMatch) {
                                return 'waiting';
                            }

                            runningTotal += Number(runningMatch[1]);
                            failedTotal += Number(failedMatch[1]);
                        }

                        if (runningTotal > 0) {
                            return 'running';
                        }

                        return failedTotal === 0 ? 'passed' : `failed:${failedTotal}`;
                    });
                },
                {
                    timeout: 120_000,
                    message: 'The browser unit harness did not settle to zero failures in time.'
                }
            )
            .toBe('passed');
    });
});
