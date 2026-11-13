# Trusted Types, and DNS hardening (CAA, DNSSEC)

- **Priority:** P4 (Website Specification, optional tier)
- **Type:** hardening
- **Spec impact:** SPEC SITE AND DISCOVERABILITY section

## Description

Add `require-trusted-types-for 'script'` once the injection sinks are audited, publish CAA records and enable DNSSEC.

## Sink audit (measured with a grep over `source/js`)

The app has few DOM injection sinks:
- 3 uses of `dangerouslySetInnerHTML` in `ui.ts` (node text, node description, zoom description), all fed by `renderInlineMarkdown` or `renderBlockMarkdown`;
- 4 `template.innerHTML` reads and writes in `markdown.ts` (the decorators, sec-10);
- no `eval`, `new Function`, `document.write`, `insertAdjacentHTML` or `srcdoc`.

Preact's `dangerouslySetInnerHTML` assigns `innerHTML`, so under Trusted Types it needs a `TrustedHTML` value. DOMPurify can return one (`RETURN_TRUSTED_TYPE`). The two third-party scripts are the unknown: the Umami tracker and `@supabase/supabase-js` must be checked for their own sinks.

## Suggested approach

1. Create one named policy (for example `virgulas-markdown`) in `markdown.ts` that wraps the sanitizer output, and use it for every sink. Combine with the single-parse refactor in sec-10 so there is one place that produces trusted HTML.
2. Ship `require-trusted-types-for 'script'; trusted-types virgulas-markdown dompurify` in a `Content-Security-Policy-Report-Only` header first (the Cloudflare ruleset can add headers; meta CSP cannot report), collect violations through `Reporting-Endpoints` (web-02), then enforce.
3. Add the CSP change to `scripts/csp.ts` with unit tests (`cspTests.ts`).
4. DNS: add CAA records restricting issuance to the CAs in use (Cloudflare and GitHub Pages certificate authorities), enable DNSSEC at the registrar and Cloudflare, and note both in the docs. This is infrastructure work outside the repo; add a checklist to [SECURITY.md](../SECURITY.md).

## Tests

Playwright with Trusted Types enforced in the test build: no violations across the main flows (including markdown rendering of hostile input).

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** M
- **Do these first:** [sec-10](sec-10-markdown-sanitizer-roundtrip.md)
- **Unblocks:** —
- **Its decision changes how these are built:** [sec-09](sec-09-csp-unsafe-inline-styles.md)
- **Shaped by:** [sec-10](sec-10-markdown-sanitizer-roundtrip.md)
- **Related:** [web-02](web-02-monitoring-status-page-and-csp-reporting.md)
