# The service worker precaches every font subset on install

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none (offline-first is a deliberate trade-off)

## Description

`FONTS_SHELL` precaches all seven Inter subsets plus icons on install, about 220 KB of Cyrillic, Greek and Vietnamese fonts that most users never render. This adds first-visit install bandwidth. The unicode-range CSS would otherwise fetch only the subsets a page needs.

## Evidence

- [source/sw.js](../../source/sw.js) (`FONTS_SHELL`)
- [source/fonts/inter/inter-google.css](../../source/fonts/inter/inter-google.css)

## Suggested fix

Precache only the Latin subset and let the cache-first handler store others on demand. Keep full precaching only if full offline coverage of every script is a product requirement.

## Tests

Playwright: service worker install fetches only the listed subset.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [web-04](web-04-fingerprinted-assets-and-immutable-caching.md)
- **Related:** [perf-05](perf-05-sw-stale-chunk-after-deploy.md)
