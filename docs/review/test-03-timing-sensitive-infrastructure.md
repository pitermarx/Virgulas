# Test infrastructure is timing-sensitive and masks flakes

- **Severity:** Low
- **Confidence:** code-read; flaky specs are from earlier review notes
- **Spec impact:** none

## Description

- Earlier notes recorded two specs that pass alone but fail under load (`sync` "sync-dot shows offline…", `sync-polling-merge` "polling pauses while conflicts…") plus occasional `due-dates` setup timeouts.
- CI retries each failing test twice, which hides intermittent product bugs.
- Three specs use `waitForTimeout` (`sync` ×2, `synctrigger` ×1) instead of waiting on a condition.
- `workers: 5` is hard-coded, regardless of machine.
- Mobile specs skip Firefox, and service-worker behaviour is tested in Chromium only, so WebKit and Firefox offline behaviour is untested.
- The config throws if Supabase credentials are missing, even for specs that never need them (see test-01).

## Evidence

- [playwright.config.ts](../../playwright.config.ts)
- [tests/integration/sync.spec.ts](../../tests/integration/sync.spec.ts), [tests/integration/synctrigger.spec.ts](../../tests/integration/synctrigger.spec.ts)
- [tests/e2e/offline.spec.ts](../../tests/e2e/offline.spec.ts)

## Suggested fix

Replace fixed waits with `expect.poll` or web-first assertions, expose the poll interval and debounce through the existing seam so tests can run them fast, and use fake timers where possible. Make `workers` depend on CPU count. Track retried-then-passed tests in the CI summary and fail when a test needs a retry on `main`. Make Supabase credentials optional for specs that do not use them.

## Tests

CI stability (retry rate) is the measure.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** M
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [ci-03](ci-03-tests-not-run-against-production-bundle.md)
