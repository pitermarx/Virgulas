# CSP allows `style-src 'unsafe-inline'`

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

The inline `style` attributes in `index.html` (for example `style="display: none;"` on the shortcuts modal) and the `<noscript><style>` block force `'unsafe-inline'`. The sanitizer strips `style` and `class`, so markdown cannot use this today. It still weakens defence in depth: any future HTML injection could use CSS exfiltration.

## Evidence

- [source/index.html](../../source/index.html) (CSP and inline styles)

## Suggested fix

Replace the inline styles with classes or the `hidden` attribute. Preact sets styles through the CSSOM, which CSP permits. For the `<noscript>` block use a stylesheet class, or a `style-src` hash. Then drop `'unsafe-inline'` from `scripts/csp.ts` output.

## Tests

`cspTests.ts` asserts the production CSP has no `'unsafe-inline'`; a Playwright smoke test checks for no CSP violations on load.

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** M
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [web-01](web-01-trusted-types-and-dns-records.md)
- **Related:** [web-05](web-05-small-cleanups.md)
