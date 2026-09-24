import { test, expect, type Page } from './test';

/**
 * Record opacity transitions on #splash. Used to prove the splash actually
 * fades on the same DOM node it later removes (a node remounted with `hidden`
 * already applied would emit no transition events at all).
 */
const trackSplashTransitions = (page: Page) =>
  page.addInitScript(() => {
    (window as any).__splashTransitions = [];
    for (const type of ['transitionrun', 'transitionend']) {
      document.addEventListener(type, (event) => {
        const transition = event as TransitionEvent;
        const target = transition.target as Element | null;
        if (transition.propertyName === 'opacity' && target?.id === 'splash') {
          (window as any).__splashTransitions.push(type);
        }
      }, true);
    }
  });

test('app shell and splash screen mount correctly', async ({ page }) => {
  const response = await page.goto('/');
  await expect(page).toHaveTitle('Virgulas');

  // The splash ships in the shell markup so it paints before the bundle runs.
  // It is a readiness gate, so it can already be gone by the time an assertion
  // polls — assert its content from the served HTML instead of racing it.
  const html = await response!.text();
  expect(html).toContain('id="splash"');
  expect(html).toContain('Local-first browser outliner');

  await expect(page.locator('#splash')).toBeHidden();
  await expect(page.locator('#app')).toBeVisible();
});

test('splash fades out on the same node, then is removed', async ({ page }) => {
  await trackSplashTransitions(page);

  await page.goto('/');
  await expect(page.locator('#splash')).toHaveCount(0);

  const transitions = await page.evaluate(() => (window as any).__splashTransitions as string[]);
  expect(transitions).toContain('transitionrun');
  expect(transitions).toContain('transitionend');

  // The app is already rendered underneath while the splash fades, so it is
  // interactive before the splash node is finally dropped.
  await expect(page.locator('#app .app-shell')).toBeVisible();
});

test('splash does not wait for the webfont', async ({ page }) => {
  await trackSplashTransitions(page);

  // Holding the font request open must not delay the reveal: the app is gated on
  // auth state only, and the webfont swaps in underneath the splash fade.
  await page.route('**/fonts/inter/*.woff2', () => { /* never resolves */ });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#splash')).toBeHidden();
  await expect(page.locator('#app .app-shell')).toBeVisible();
});

/**
 * The bundle URL must carry a version query. Without it a service worker can
 * serve a cached `js/app.js` alongside a freshly fetched `index.html`, which is
 * how the v2 release shipped a bundled script into a page that no longer had an
 * import map and failed with a bare `htm/preact` specifier.
 */
test('bundle assets are version-stamped and resolve', async ({ page }) => {
  const response = await page.goto('/');
  const html = await response!.text();

  const script = html.match(/src="(js\/app\.js\?v=[^"]+)"/)?.[1];
  const style = html.match(/href="(js\/app\.css\?v=[^"]+)"/)?.[1];

  expect(script, 'the module script is versioned').toBeTruthy();
  expect(style, 'the stylesheet link is versioned').toBeTruthy();

  // Both assets must carry the same version, so a release swaps them together.
  expect(script!.split('?v=')[1]).toBe(style!.split('?v=')[1]);

  // The service worker precaches these exact URLs, so they must be fetchable.
  for (const asset of [script!, style!]) {
    const assetResponse = await page.request.get('/' + asset);
    expect(assetResponse.status(), asset).toBe(200);
  }
});
