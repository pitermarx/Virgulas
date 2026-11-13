# Retry and polling hygiene

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** SPEC states "3 retries with exponential back-off"; adding error classes does not contradict it

## Description

- `retryWithBackoff` retries every error, including non-retryable ones (RLS denial, the 16 MiB size constraint, auth errors). Each waits 0.5, 1 and 2 s for nothing.
- The 60 s poll keeps running in background tabs and while offline.
- Several tabs open in Remote mode each poll and push independently.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L224)
- [source/js/sync.ts](../../source/js/sync.ts#L513)

## Suggested fix

Retry only network errors and 5xx/429. Skip polls while `document.visibilityState === 'hidden'` or `navigator.onLine === false`, and poll immediately on `visibilitychange`/`online`. Elect one leader tab with the Web Locks API.

## Tests

Unit tests for the retry classifier. A Playwright test with the page hidden asserts no poll request.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Unblocks:** [scale-02](scale-02-transfer-cost-model.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [scale-02](scale-02-transfer-cost-model.md)
