# No backoff when a pull keeps failing

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none

## Description

If decrypt or merge fails (wrong passphrase after a rotation elsewhere, malformed remote data, a thrown `TypeError` in the merge), `lastSyncedAt` never advances. `checkRemoteNewer` stays true, so every 60 s poll and every save downloads the whole document again. The key cache is small and bounded, so an alternating salt can still re-run the 600k-iteration PBKDF2.

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts#L395) (`pullAndMerge`)
- [source/js/sync.ts](../../source/js/sync.ts#L513) (`startPolling`)

## Suggested fix

Remember the last failed remote `updated_at` and skip it until it changes. Add exponential backoff to the poll after consecutive failures. Surface the failure state to the user. Validate the remote payload shape before merging.

## Tests

Unit test: after a failed pull for timestamp T, further polls with the same T do not call `remoteSync.read`.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
