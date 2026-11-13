# The Supabase client chunk carries unused clients

- **Severity:** Low
- **Confidence:** measured (`@supabase/supabase-js` bundles to 226.7 KB minified; `@supabase/auth-js` plus `@supabase/postgrest-js` bundle to 124.1 KB)
- **Spec impact:** Rule 6 names "Supabase JS client from npm"; switching to its sub-packages needs a decision

## Description

The app uses password auth and one table (`outlines`). `supabase-js` also includes the realtime, storage and functions clients, which are unused (realtime is explicitly disabled). The chunk is lazy, so only Remote users pay, but they pay on every cold start and the service worker caches it on first use.

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts) (`createClient`, `realtime: { enabled: false }`)
- [package.json](../../package.json)

## Suggested fix

Use `@supabase/auth-js` and `@supabase/postgrest-js` directly (about 45% smaller). They are already installed transitively, maintained by the same organisation, and expose the same calls used in `remoteSync`. Keep the dynamic import and the test seam. Verify session persistence, token refresh and error shapes against the current behaviour. Skip this if the saving is not worth the divergence from the standard client.

## Tests

The existing sync and auth specs through the `__TEST_HOOKS__` seam, plus a real-backend smoke test (test-01).

<!-- roadmap -->
## Roadmap position

- **Phase:** [4 — Decide and measure](README.md#phase-4)
- **Size:** M
- **Do these first:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md), [test-01](test-01-no-real-backend-e2e.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md)
- **Related:** —
