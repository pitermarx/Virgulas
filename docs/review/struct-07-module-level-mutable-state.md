# Module-level mutable state in the save and sync pipeline

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

Timers and flags live as module variables: `lastTimeoutId`, `maxWaitTimer`, `pendingSave`, `activeSave`, `saveArmed`, `lastSavedVersion`, `deferredPushTimer`, `deferredPushPayload`, plus `_passphrase`, `_salt`, `lastCompletedRemotePush`, `remoteSyncQueue` and the cross-module `skipNextRemotePush` flag in `sync.ts`. Teardown paths (lock, sign-out, delete account, reset) must each remember to clear the right subset; the code carries comments about bugs that came from missing one.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts)
- [source/js/sync.ts](../../source/js/sync.ts)

## Suggested fix

Encapsulate the pipeline in one `SaveSession` object created at unlock and disposed at lock/sign-out/reset, owning its timers, payload and credentials. Replace `skipNextRemotePush` with an explicit "applied from remote" marker on the saved version.

## Tests

Unit tests that every teardown path leaves no pending timers (fake timers) and no credentials.

<!-- roadmap -->
## Roadmap position

- **Phase:** [2 — Make persistence and sync changeable](README.md#phase-2)
- **Size:** M
- **Do these first:** —
- **Unblocks:** [dur-01](dur-01-multi-tab-overwrites.md), [roadmap-05](roadmap-05-multi-document-workspaces.md), [sec-11](sec-11-no-idle-auto-lock.md), [struct-01](struct-01-oversized-modules.md), [ux-02](ux-02-no-undo.md)
- **Its decision changes how these are built:** [ux-02](ux-02-no-undo.md)
- **Shaped by:** —
- **Related:** —
