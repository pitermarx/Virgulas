# Retry and polling hygiene

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** SPEC states "3 retries with exponential back-off"; adding error classes does not contradict it
- **Status:** partly fixed. `retryWithBackoff` in `syncEngine.ts` now retries only typed `network` and `unauthenticated` failures, so RLS, size and auth errors fail immediately. Still open: the 60 s poll runs in hidden and offline tabs, and every Remote tab polls independently.

## Description

- The retry classifier is fixed (see Status). The remaining issues are:
- The 60 s poll keeps running in background tabs and while offline.
- Several tabs open in Remote mode each poll and push independently.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L224)
- [source/js/sync.ts](../../source/js/sync.ts#L513)

## Suggested fix

Skip polls while `document.visibilityState === 'hidden'` or `navigator.onLine === false`, and poll immediately on `visibilitychange`/`online`. Elect one leader tab with the Web Locks API (the same lock as dur-01).

## Tests

A Playwright test with the page hidden asserts no poll request; a two-tab test asserts only the leader polls.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** —
- **Unblocks:** [scale-02](scale-02-transfer-cost-model.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [scale-02](scale-02-transfer-cost-model.md)
