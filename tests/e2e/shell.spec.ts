import { test, expect, type Page } from '../test';

/**
 * Record opacity transitions on #splash. Used to prove the splash actually
 * fades on the same DOM node it later removes (a node remounted with `hidden`
 * already applied would emit no transition events at all).
 *
 * The completion is recorded too: the app arms its removal fallback from the
 * fade's first frame (`scheduleSplashDismissal` in app.ts), so the fade always
 * finishes before the node can be dropped — but the `visibility` step that ends
 * it lands on the same instant (base.css), and the engine may report that as a
 * cancellation of the opacity transition instead of an end.
 */
const trackSplashTransitions = (page: Page) =>
  page.addInitScript(() => {
    const state: { events: string[]; runNode: Element | null } = { events: [], runNode: null };
    (window as any).__splash = state;
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) {
      document.addEventListener(type, (event) => {
        const transition = event as TransitionEvent;
        const target = transition.target as Element | null;
        if (transition.propertyName !== 'opacity' || target?.id !== 'splash') return;
        // The node the fade started on: the removal below must be that node.
        if (type === 'transitionrun' && !state.runNode) state.runNode = target;
        state.events.push(type);
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
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // The removal fallback is armed when the app becomes ready, and the fade only
  // starts once the render after that flip applies `hidden`. On a busy main
  // thread that gap can be hundreds of milliseconds; hold the render for 600 ms
  // to reproduce it, because that is the condition that turned main red on
  // 2026-11-14 (the fallback then dropped the node mid-fade and no completion
  // event arrived). The fade must still finish before the node is dropped.
  //
  // `data-main-view` is already set by the bootstrap; the render sets it again
  // just before it diffs the splash's class, which is where the frame is spent.
  await page.addInitScript(() => {
    const setAttribute = Element.prototype.setAttribute;
    let delayed = false;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (
        !delayed &&
        name === 'data-main-view' &&
        this === document.body &&
        document.body.getAttribute('data-main-view') === 'rendered'
      ) {
        delayed = true;
        const until = Date.now() + 600;
        while (Date.now() < until) { /* a frame the boot spends on other work */ }
      }
      return setAttribute.call(this, name, value);
    };
  });

  // Hold the memory-mode bootstrap until the browser has computed the visible
  // splash style. Otherwise a fast boot can apply `hidden` before the first
  // style recalc; CSS then sees only opacity:0 and correctly emits no transition
  // events. This test specifically checks the fade path, so make its starting
  // state deterministic instead of racing the network/first paint.
  let releaseIntro!: () => void;
  let markIntroRequested!: () => void;
  const introGate = new Promise<void>(resolve => { releaseIntro = resolve; });
  const introRequested = new Promise<void>(resolve => { markIntroRequested = resolve; });
  await page.route('**/intro.vmd', async route => {
    markIntroRequested();
    await introGate;
    await route.continue();
  });

  await page.goto('/', { waitUntil: 'commit' });
  await introRequested;
  await page.waitForFunction(() => {
    const splash = document.getElementById('splash');
    if (!splash) return false;
    const style = getComputedStyle(splash);
    return style.opacity === '1' && parseFloat(style.transitionDuration) > 0;
  });
  // Reading computed styles is not enough: headless Chromium may defer its first
  // paint while workers are busy. A screenshot forces the visible starting state
  // to be painted before releasing bootstrap and triggering the transition.
  try {
    await page.locator('#splash').screenshot();
  } finally {
    releaseIntro();
  }

  await expect(page.locator('#splash')).toHaveCount(0);

  const observed = await page.evaluate(() => {
    const state = (window as any).__splash as { events: string[]; runNode: Element | null };
    return {
      events: state.events,
      hadRunNode: state.runNode !== null,
      runNodeStillConnected: state.runNode?.isConnected === true
    };
  });

  // The fade starts on the splash itself. A node remounted with `hidden`
  // already applied emits nothing, and so does a fade that is switched off
  // (reduced motion, or `transition: none`).
  expect(observed.events, 'the splash opacity transition did not start').toContain('transitionrun');

  // The fade then finishes before the removal can drop the node: the fallback
  // deadline is measured from the frame the fade starts, not from the moment the
  // app became ready. Either the transition ends, or the `visibility` step that
  // lands on the same instant cancels it.
  expect(
    observed.events.some(type => type === 'transitionend' || type === 'transitioncancel'),
    'the splash opacity transition neither ended nor was cancelled'
  ).toBe(true);

  // The node that faded is the node that was removed, not a remount.
  expect(observed.hadRunNode, 'no splash node started a fade').toBe(true);
  expect(observed.runNodeStillConnected, 'the node that faded is the node that was removed').toBe(false);

  // The app is already rendered underneath while the splash fades, so it is
  // interactive before the splash node is finally dropped.
  await expect(page.locator('#app .app-shell')).toBeVisible();
});

test('splash is removed even when no transition event arrives', async ({ page }) => {
  // WebKit can stall or skip a transition while the browser is busy, so removal
  // cannot hang off `transitionend`. Swallow the transition events in the
  // capture phase, before they can reach the splash's handler, so only the
  // fallback timer in app.ts can drop the node.
  await page.addInitScript(() => {
    for (const type of ['transitionrun', 'transitionend']) {
      document.addEventListener(type, event => event.stopPropagation(), true);
    }
  });

  await page.goto('/');
  await expect(page.locator('#splash')).toHaveCount(0);
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
