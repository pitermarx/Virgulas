# `lastSyncedAt` is stamped after the upload, hiding edits made during it

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none
- **Status:** mostly fixed. The deferred-push path is gone, and the normal upload path stamps `lastSyncedAt` only when the write epoch still matches, so an edit during the upload is not hidden. Remaining: the refold branch in `syncEngine.ts` stamps `Date.now()` after the upload (line 364); a remote edit that lands between that stamp and the folded push can still win for the same node.

## Description

The normal path now checks the write epoch before stamping, so an edit made during the upload keeps the old baseline and is not hidden. The remaining hole is the refold branch: it stamps completion time after uploading the merge result and before the folded local document is pushed. A remote edit that lands in that window is newer than the baseline and can win the same node.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts) (the Remote save edge)
- [source/js/syncEngine.ts](../../source/js/syncEngine.ts) (`syncOnce`)
- [source/js/sync.ts](../../source/js/sync.ts) (`resolveConflicts`)

## Suggested fix

In the refold branch, keep the pre-upload baseline (or record the uploaded snapshot time) so the folded local edit stays newer than the baseline. Let the triggered save stamp after its own successful push. Combine with the server `updated_at` from sync-04.

## Tests

Unit test: edit during a mocked slow upload, then merge against a remote edit; assert the local edit survives or conflicts.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [dur-01](dur-01-multi-tab-overwrites.md)
