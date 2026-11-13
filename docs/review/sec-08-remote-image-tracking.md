# Remote images in markdown leak the user's IP and open time

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** SPEC states images load normally

## Description

The CSP allows `img-src https: http:` and the sanitizer allows `<img>` with http(s) sources. `referrerpolicy="no-referrer"` hides the app URL, but the image host still sees the viewer's IP, user agent and the time each device opens the document. Combined with sec-01, an attacker can plant such an image remotely. A hostile `.vmd` import or paste does the same.

## Evidence

- [source/js/markdown.ts](../../source/js/markdown.ts) (`hardenImages`)
- [source/index.html](../../source/index.html) (CSP `img-src`)

## Suggested fix

Load remote images only after a per-image click ("Load image"), or add an Options toggle defaulting to off. Alternatively restrict `img-src` to `'self' data:` and let users opt in. Needs a SPEC decision.

## Tests

Playwright: a node with `![](https://example.test/p.png)` makes no request until the user opts in.

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** S · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** —
- **Unblocks:** [roadmap-07](roadmap-07-load-vmd-from-query-string.md)
- **Its decision changes how these are built:** [roadmap-07](roadmap-07-load-vmd-from-query-string.md)
- **Shaped by:** —
- **Related:** —
