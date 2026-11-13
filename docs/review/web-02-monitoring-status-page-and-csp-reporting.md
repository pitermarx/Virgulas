# Monitoring, a status page and CSP violation reporting

- **Priority:** P4 (Website Specification, optional tier)
- **Type:** operations
- **Spec impact:** none in the app; SPEC site section may list the endpoints

## Description

External uptime checks, a status page on a separate host, and `Reporting-Endpoints` for CSP violations.

This extends scale-03 (backend availability), which covers synthetic checks of Supabase and the analytics host. This item adds the public-facing side.

## Suggested approach

- **Uptime:** an external monitor (any hosted service or a scheduled GitHub Action, though a GitHub-hosted check shares failure modes with Pages) for the site, `/version.json`, the Supabase auth health endpoint and the analytics host.
- **Status page:** hosted on a different provider and domain from the app, so it stays up when the app does not. Link it from the privacy page and the footer in Options.
- **CSP reporting:** add `Reporting-Endpoints: csp="https://<collector>"` and a report-only second policy with `report-to csp` through `scripts/cloudflare-headers.mjs`. The meta CSP in `index.html` cannot send reports, so a header is required. Use a collector that stores no personal data, and note it on the privacy page. Expect noise from browser extensions; filter by `blocked-uri` scheme.
- **Use the reports** to validate the Trusted Types rollout (web-01) and to catch an unexpected third-party request.

## Tests

A unit test on the header builder in `cloudflare-headers.mjs`; the deploy job already fails if headers cannot be applied.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** M
- **Do these first:** [scale-03](scale-03-backend-availability-monitoring.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [web-01](web-01-trusted-types-and-dns-records.md)
