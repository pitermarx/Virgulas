# No end-to-end test talks to a real Supabase

- **Severity:** Medium
- **Confidence:** measured (no `/auth/v1` or `/rest/v1` request in `tests/`; every sync and auth spec injects a hand-written `createClient` mock)
- **Spec impact:** none

## Description

The Playwright config refuses to start without local Supabase credentials, and CI starts a full local Supabase stack in each of the three shards, but `admin`, `auth`, `sync`, `sync-polling-merge` and `synctrigger` all replace the client with a mock through the test seam. So the real GoTrue, PostgREST, row-level security, size constraints and migrations are never exercised end to end. The mocks are re-implemented in at least four spec files and can drift from real behaviour (error shapes, `PGRST116`, `updated_at` handling, session refresh). Production specs that could cover the real client are excluded from the daily run because the seam is compiled out.

## Evidence

- [tests/integration/sync.spec.ts](../../tests/integration/sync.spec.ts), [tests/integration/auth.spec.ts](../../tests/integration/auth.spec.ts), [tests/integration/admin.spec.ts](../../tests/integration/admin.spec.ts), [tests/integration/sync-polling-merge.spec.ts](../../tests/integration/sync-polling-merge.spec.ts)
- [playwright.config.ts](../../playwright.config.ts)
- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)

## Suggested fix

Add a small real-backend suite that runs against the production-shaped bundle (the `production-bundle` job; ci-03) and local Supabase: sign up, sign in, upload, second context pulls, RLS denies another user's row, the 16 MiB constraint rejects, delete-account works. Keep mocks only for failure injection, and move the mock into one shared fixture in `tests/test.ts`. If the real suite is not added, stop starting Supabase in CI.

## Tests

The new suite is the test.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** L
- **Do these first:** —
- **Unblocks:** [dep-02](dep-02-supabase-client-footprint.md), [priv-03](priv-03-account-erasure-is-manual.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [struct-02](struct-02-duplicated-remote-push-logic.md)
