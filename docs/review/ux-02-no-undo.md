# No undo for edits or deletions

- **Severity:** Medium
- **Confidence:** code-read; listed in the SPEC ROADMAP
- **Spec impact:** SPEC ROADMAP specifies `Ctrl+Z` / `Ctrl+Shift+Z` with a capped history

## Description

Deleting a node without children has no confirmation and no way back; nodes with children get a `confirm()` only. Pasting multi-line text into a node replaces its children. Moves, outdents (which re-parent the following siblings) and task toggles are not reversible. With no version history either (dur-03), one mistaken keystroke can lose work permanently.

## Evidence

- [source/js/outline.ts](../../source/js/outline.ts) (`deleteNode`, `setVMD`, `outdent`)
- [docs/SPEC.vmd](../SPEC.vmd) (ROADMAP)

## Suggested fix

Record inverse operations or snapshots at the `outline.update` boundary (every mutation already goes through it) in a bounded stack of about 100 entries, coalescing consecutive typing in one node. Clear the stack on `deserialize` (unlock, sync merge) and decide how a remote merge interacts with it. Wire `Ctrl+Z` and `Ctrl+Shift+Z`.

## Tests

Unit tests per operation (undo then redo restores the serialised document); Playwright for the shortcuts.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** L
- **Do these first:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [struct-07](struct-07-module-level-mutable-state.md)
- **Unblocks:** [roadmap-02](roadmap-02-drag-and-drop-reordering.md), [roadmap-05](roadmap-05-multi-document-workspaces.md)
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [dur-03](dur-03-no-versioned-backups.md), [struct-07](struct-07-module-level-mutable-state.md)
- **Related:** —
