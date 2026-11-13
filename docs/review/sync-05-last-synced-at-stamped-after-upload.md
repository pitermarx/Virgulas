# `lastSyncedAt` is stamped after the upload, hiding edits made during it

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

After a push, the code calls `setLastSyncedAt(Date.now())`. An edit made while the upload was in flight has a `lastModified` earlier than that value. The next merge sees it as unchanged, so a concurrent remote edit of the same node wins and the local edit is lost. Some paths guard with `isRemoteSyncAttemptStale`; the deferred-push path does not.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts) (`flushDeferredPush`, `doSave`)
- [source/js/sync.ts](../../source/js/sync.ts) (`resolveConflicts`)

## Suggested fix

Record the timestamp of the snapshot that was uploaded (`attempt.startedAt`, already available), not the completion time. Combine with the server `updated_at` from sync-04.

## Tests

Unit test: edit during a mocked slow upload, then merge against a remote edit; assert the local edit survives or conflicts.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [dur-01](dur-01-multi-tab-overwrites.md)
