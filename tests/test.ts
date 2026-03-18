import { test as base, expect } from '@playwright/test';

const configJson = (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.PLAYWRIGHT_SUPABASE_CONFIG
);

export const test = base.extend({
    page: async ({ page }, use) => {
        if (configJson) {
            await page.addInitScript((value: string) => {
                localStorage.setItem('supabaseconfig', value);
            }, configJson);
        }

        await use(page);
    }
});

export { expect };
export type { Page, Locator } from '@playwright/test';
