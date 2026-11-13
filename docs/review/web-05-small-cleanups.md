# Small website cleanups

- **Priority:** P4 (Website Specification, optional tier)
- **Type:** collection of small items
- **Spec impact:** SPEC SITE AND DISCOVERABILITY for the discovery files

## Items

### Locale-aware dates (i18n)
`formatDueDate` hard-codes `en-US`. Tracked in i18n-01 with the other locale issues.

### `llms-full.txt` and per-page markdown endpoints
`source/llms.txt` exists. The site has only three pages (app, privacy, 404), so a `llms-full.txt` that inlines the README and the privacy text, and `.md` versions of the privacy page, are cheap. Generate them in the build from the existing docs so they cannot drift (the privacy page showed how pages drift). Add them to `sitemap.xml` and the `website-spec` tests.

### Speculation Rules
Low value here: the app is a single page, and the only other navigations are the privacy and 404 pages. Prefetching `/privacy.html` on hover of the footer link is possible with a small inline rules block, but a `<script type="speculationrules">` needs CSP allowance (`inline-speculation-rules` source) in a policy that otherwise forbids inline script. Skip unless there are more pages (for example the pricing page, roadmap-07).

### Critical CSS
`app.css` (about 39 KB) is a render-blocking `<link>`. The splash is static markup, so inlining its few rules would let it paint before the stylesheet arrives. It needs inline `<style>`, and the production CSP allows only `style-src 'self' 'unsafe-inline'` today because of existing inline styles; if sec-09 removes `'unsafe-inline'`, a hash-based allowance would be needed instead. Measure first (web-03).

### Honouring Global Privacy Control
The site publishes `/.well-known/gpc.json` and the privacy page says no personal data is sold or shared. Honouring the signal means the tracker must not run when `navigator.globalPrivacyControl` is true. Umami's own `data-do-not-track` handles Do Not Track, not GPC (the DNT attributes already ship from the sec-02 work). Because the tracker is a static tag, honouring GPC needs a small bundle step that injects the SRI-pinned script only when the signal is absent (CSP and SRI still apply).


## Tests

`website-spec` checks for each new discovery file; a unit test that the tracker is not injected when `globalPrivacyControl` is true.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** M
- **Do these first:** [web-03](web-03-core-web-vitals-measurement.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [i18n-01](i18n-01-english-only-and-layout-dependent-shortcuts.md), [sec-09](sec-09-csp-unsafe-inline-styles.md)
