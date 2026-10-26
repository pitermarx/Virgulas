import { test, expect } from '../test';

// sec-05: the introspection seam on /js/app.js is published through a single
// `e2e` binding that is populated only in the test build. Plain static
// re-exports used to leak the raw singletons to any same-origin module, and
// with them `persistence.getPassphrase()`.
//
// This spec runs unchanged against the production bundle in the daily
// workflow: there `Object.keys(e2e)` must be empty, while in the test build it
// must carry everything the specs rely on.
test('the e2e introspection seam is populated only in the test build', async ({ page }) => {
    await page.goto('/');

    const seam = await page.evaluate(async () => {
        const mod = await import('/js/app.js' as string);
        return Object.keys((mod as { e2e?: Record<string, unknown> }).e2e ?? {});
    });

    if (seam.length === 0) {
        // Production build: no introspection exports may leak.
        expect(seam).toEqual([]);
        return;
    }

    // Test build: the whole seam must be published, the specs depend on it.
    expect(seam.sort()).toEqual([
        'currentSearchMatchId',
        'decrypt',
        'encrypt',
        'generateSalt',
        'getFirstClosedParent',
        'inbox',
        'mergeDocuments',
        'outline',
        'persistence',
        'pendingConflicts',
        'randomId'
    ].sort());

    // The passphrase accessor must not exist in any build (sec-05).
    const exposesPassphraseAccessor = await page.evaluate(async () => {
        const mod = await import('/js/app.js' as string) as { e2e?: { persistence?: Record<string, unknown> } };
        return mod.e2e?.persistence ? 'getPassphrase' in mod.e2e.persistence : false;
    });
    expect(exposesPassphraseAccessor).toBe(false);
});
