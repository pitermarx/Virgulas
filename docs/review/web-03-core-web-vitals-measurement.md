# Core Web Vitals measurement

- **Priority:** P4 (Website Specification, optional tier)
- **Type:** measurement
- **Spec impact:** none

## Description

The audit left Core Web Vitals UNCLEAR. Measure LCP, INP and CLS from CrUX or PageSpeed Insights.

## Context

- A small site may not appear in CrUX at all (it needs enough real Chrome traffic), so PageSpeed Insights may show lab data only.
- The app's first paint is a static splash from `index.html`; LCP is likely the splash logo or the first rendered node, and the render-blocking stylesheet (about 39 KB) plus the 207 KB bundle decide it. The code already avoids waiting on the webfont for reveal.
- INP depends on the per-keystroke work described in perf-01 and perf-02, which grows with document size (perf-08).
- CLS risk: the splash-to-app swap, the font swap (`font-display: swap`) and late-rendered banners.

## Suggested approach

1. Run Lighthouse (mobile preset, throttled) and PageSpeed Insights against the production URL and record the numbers in a dated note.
2. Add field measurement without a new dependency: a few lines using `PerformanceObserver` for `largest-contentful-paint`, `layout-shift` and `event` entries, sent only to the existing analytics as custom events (check the privacy wording and consent). Alternatively use Chrome's `web-vitals` library, which needs approval under Rule 6.
3. Use a large test document (perf-08) for INP, not only the intro document.
4. Put the budgets in the docs and a Lighthouse CI assertion once stable.

## Tests

A Lighthouse CI step with budgets for LCP, CLS and total blocking time on the intro document.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** S
- **Do these first:** [perf-08](perf-08-document-size-limits-and-old-devices.md)
- **Unblocks:** [growth-01](growth-01-publicity-and-monetisation.md), [web-05](web-05-small-cleanups.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [perf-02](perf-02-subtree-rerender-no-render-cache.md)
