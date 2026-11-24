# Real-backend coverage stops at mocks; the TrailBase live suite never runs in CI

- **Severity:** Medium
- **Confidence:** measured (the TrailBase live suite exists; CI never starts its compose stack; no Supabase fallback live suite)
- **Spec impact:** none
- **Status:** narrowed. `tests/e2e/trailbase-live.spec.ts` drives the real app against a real local TrailBase (register, email verification, sign-in, upload, pull, RLS, delete) but skips itself unless the compose stack is running, and no workflow runs it. Every Supabase sync/auth spec still uses the `window.supabase` mock. The production-bundle job does not start a backend.

## Description

The app now defaults to TrailBase on the serving origin, with hosted Supabase as the fallback. The real-backend suite for the default shape exists, so the gap is narrower than "no real backend": it is not wired into CI, and the Supabase fallback has no live coverage. The mocks remain the only automated coverage for GoTrue, PostgREST, RLS, size constraints and migrations.

## Suggested fix

1. Add a CI job that builds the app, starts `scripts/trailbase/compose.yml` (with Mailpit), waits for the health endpoints, and runs `tests/e2e/trailbase-live.spec.ts` against the built bundle. Keep it out of the sharded `test` job; it is a single production-shaped smoke.
2. After that, add the same shape for the Supabase fallback: local Supabase, production bundle, one sign-up/upload/pull/RLS/delete journey. Keep mocks only for failure injection.
3. If the Supabase live suite is not wanted, stop starting Supabase in the sharded `test` job (or document why it stays).

## Tests

The CI job is the test. It must fail on a real auth/RLS/migration regression, not retry it away.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** L
- **Do these first:** —
- **Unblocks:** [dep-02](dep-02-supabase-client-footprint.md), [priv-03](priv-03-account-erasure-is-manual.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
