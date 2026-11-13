# Tests do not run against the production bundle before deploy

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none

## Description

CI runs E2E against `dev:test` (test hooks on, PBKDF2 scaled down 60x, permissive CSP). Production deploys a different build (hooks off, full KDF cost, pinned CSP). The daily production run excludes the specs that need the hook seam (admin, auth, sync, sync-polling-merge, synctrigger). Therefore the production-built sync, auth and CSP paths are never exercised by E2E before they ship.

## Evidence

- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
- [.github/workflows/daily.yml](../../.github/workflows/daily.yml)
- [scripts/build-bun.mjs](../../scripts/build-bun.mjs)

## Suggested fix

Add a smoke job that builds with the deploy flags, serves `dist/`, and runs a small spec set against it: unlock, Local save and reload, CSP violation check, service worker install, and a real sign-in/sync against local Supabase with the real KDF cost. Make `deploy` depend on it.

## Tests

The smoke job is the test; it should fail if the production bundle regresses.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** M
- **Do these first:** [test-01](test-01-no-real-backend-e2e.md)
- **Unblocks:** [web-04](web-04-fingerprinted-assets-and-immutable-caching.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [test-03](test-03-timing-sensitive-infrastructure.md)
