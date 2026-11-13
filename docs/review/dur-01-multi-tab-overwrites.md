# Two tabs overwrite each other's edits

- **Severity:** High
- **Confidence:** code-read (no `storage`, `BroadcastChannel` or Web Locks usage exists in `source/js`)
- **Spec impact:** none (a "document open in another tab" state may need SPEC wording)

## Description

Each tab keeps its own in-memory document and autosaves it as a whole.
- **Local mode:** both tabs write the same `vmd_data_enc` key, so the last save wins and the other tab's edits vanish with no warning.
- **Remote mode:** `vmd_sync_ts` is shared through localStorage. When tab A pushes and records `lastSyncedAt`, tab B's pull-before-push sees "remote not newer" and pushes its stale document over A's changes.
- **File mode:** both tabs write the same file.

Nothing detects a second tab, and nothing reloads the document when another tab saves.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L431) (save pipeline)
- [source/js/sync.ts](../../source/js/sync.ts#L371) (`getLastSyncedAt` reads shared storage)

## Suggested fix

Elect one writer tab with the Web Locks API (`navigator.locks.request('virgulas-doc', { ifAvailable: true })`). A second tab opens read-only with a banner ("Open in another tab") and a "Take over" action. Alternatively, listen for the `storage` event on `vmd_data_enc` and `vmd_sync_ts`, and merge or reload the document when another tab saves. Keep `lastSyncedAt` per tab (in memory), or store it with a tab id.

## Tests

Playwright with two pages in one context: edit in both, assert nothing is lost (or that the second tab is read-only).

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** M
- **Do these first:** [struct-07](struct-07-module-level-mutable-state.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [sync-05](sync-05-last-synced-at-stamped-after-upload.md)
