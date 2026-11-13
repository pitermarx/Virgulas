# Edits made behind the conflict dialog are overwritten

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** SPEC says "the app cannot be used until all conflicts are resolved"; the implementation does not enforce it

## Description

The conflict dialog is an overlay, but the outline behind it stays interactive (it is not `inert`, and `document.onkeydown` stays active). A user can keep typing. When they press Apply, `resolveConflicts` serialises the merge snapshot taken at pull time and calls `outline.deserialize` with it, so everything typed since the dialog opened is replaced. Polling and pushes also pause while conflicts are pending, so those edits are not even uploaded.

## Evidence

- [source/js/ui.ts](../../source/js/ui.ts#L816) (`document.onkeydown`)
- [source/js/ui.ts](../../source/js/ui.ts#L818) (`ConflictModal`)
- [source/js/sync.ts](../../source/js/sync.ts) (`resolveConflicts`)
- [source/js/app.ts](../../source/js/app.ts#L1337)

## Suggested fix

The app is now inert while conflicts are pending (a11y-02); make the global keydown handler ignore the outline in that state too. Because a merge snapshot can still go stale (for example a poll lands first), have `resolveConflicts` re-merge against the current local document instead of replacing it.

## Tests

Playwright: with a conflict open, typing in the outline is blocked; unit test that apply keeps local-only nodes added after the snapshot.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
