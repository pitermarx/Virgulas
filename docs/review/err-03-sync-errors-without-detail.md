# Sync errors carry no detail, retry action or diagnostics

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

When sync fails, `syncStatus` becomes `error` or `offline` and the dot turns red or grey. The cause (auth expired, size limit, RLS denial, network, undecryptable data) is discarded or only logged when `localStorage.vmd_debug === '1'`. There is no "Retry now" action, no last-success time and no way for a user to report a problem without opening DevTools. Production has no error telemetry either, so failures are only found by users.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L583)
- [source/js/utils.ts](../../source/js/utils.ts) (`log`)
- [source/js/ui.ts](../../source/js/ui.ts#L585)

## Suggested fix

Keep a small in-memory ring buffer of structured sync events (time, step, error code, no content). Show the last error and last-success time in the status tooltip or Options, add "Retry now", and a "Copy diagnostics" button that exports app version, mode, storage state and recent events. Map auth-expired to a sign-in prompt.

## Tests

Unit test for the ring buffer and error classification; Playwright for the retry button.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** M
- **Do these first:** —
- **Unblocks:** [roadmap-01](roadmap-01-queued-background-sync.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [scale-03](scale-03-backend-availability-monitoring.md)
