# Conflict resolution is coarse and hard to judge

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** SPEC fixes the per-conflict "Keep local / Keep remote" model

## Description

Each conflict is a whole-field choice. There is no diff highlighting, no "keep both" or edit-in-place option, and no preview of the resulting outline. Text and description values appear in read-only textareas. For `children`, the dialog lists child texts only if the node is in the merge snapshot and falls back to showing raw ids. Because the merge has no base version (sync-06), the dialog often asks about fields the user never changed. With many conflicts the user must resolve each one before the app is usable again.

## Evidence

- [source/js/ui.ts](../../source/js/ui.ts#L818) (`ConflictModal`, `renderValue`)

## Suggested fix

Fix the cause first (three-way merge, ordered children union) so far fewer conflicts appear. Then improve the dialog: word-level diff, a "keep both" for text (append the other value), a list view that shows the node's path, and a default selection (newest side) that can be confirmed in one click. Allow "Decide later" by keeping both versions in a conflict copy node.

## Tests

Playwright for keep-both and default-apply; unit tests for the diff helper.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** M · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [sync-06](sync-06-disjoint-field-edits-conflict.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Related:** [sync-06](sync-06-disjoint-field-edits-conflict.md)
