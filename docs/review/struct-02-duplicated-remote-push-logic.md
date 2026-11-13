# The remote push and merge logic exists in four copies

- **Severity:** High (it is how sync-01 and sync-02 happened)
- **Confidence:** code-read
- **Spec impact:** none

## Description

Pull-before-push, retry, stale-attempt checks and "apply merged document" are implemented separately in:
1. the debounced autosave in `doSave`,
2. `flushDeferredPush`,
3. `startPolling`,
4. `resolveConflicts`.

They differ in subtle ways: which paths call `recordCompletedRemotePush`, which check staleness, which call `retryWithBackoff`, which update the local ciphertext. The same issue was flagged in the earlier review notes.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts) (`flushDeferredPush`, `doSave`)
- [source/js/sync.ts](../../source/js/sync.ts) (`startPolling`, `resolveConflicts`)

## Suggested fix

Extract one `syncOnce({ trigger, localEncrypted? })` in the sync layer that returns a typed result (`pushed`, `merged`, `conflict`, `undecryptable`, `skipped`, `error`). Callers only decide when to call it. Do this before fixing sync-01 to sync-05, so each fix lands once.

## Tests

Table-driven unit tests over the result types with mocked `remoteSync`; existing sync specs stay green.

<!-- roadmap -->
## Roadmap position

- **Phase:** [2 — Make persistence and sync changeable](README.md#phase-2)
- **Size:** L
- **Do these first:** —
- **Unblocks:** [roadmap-01](roadmap-01-queued-background-sync.md), [struct-01](struct-01-oversized-modules.md), [struct-03](struct-03-minor-duplications.md), [struct-05](struct-05-any-typing-and-unchecked-scripts.md), [sync-03](sync-03-no-backoff-on-failing-pull.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md), [sync-05](sync-05-last-synced-at-stamped-after-upload.md), [sync-07](sync-07-full-document-transfer-and-double-download.md), [sync-09](sync-09-retry-and-polling-hygiene.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [test-01](test-01-no-real-backend-e2e.md)
