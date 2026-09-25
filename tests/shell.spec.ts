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

test('reduced motion collapses design-system transitions', async ({ page }) => {
  // Browsers serialise the token differently (150ms vs .15s), so compare the
  // parsed duration instead of the raw string.
  const transitionSeconds = () =>
    page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--transition-base'))
    );

  await page.goto('/');
  await expect(page.locator('#splash')).toBeHidden();
  expect(await transitionSeconds()).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await transitionSeconds()).toBe(0);
});
