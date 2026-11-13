# Merge silently drops `done` and `parentId` changes

- **Severity:** Medium
- **Confidence:** verified (probe: a remote `done: true` was lost, only a `text` conflict appeared)
- **Spec impact:** SPEC lists per-field comparison for text/description/children and LWW for `open`; `done` and `parentId` are not mentioned

## Description

When a node changed on both sides, `mergedNode = { ...local }` makes local win every field not explicitly handled. `done` (task state) and `parentId` (moves) never conflict and never use last-writer-wins, so a remote toggle or move is silently discarded. A remote move combined with a local edit can leave the node absent from its new parent's `children` (it is then dropped by `deserialize` validation).

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts#L310)

## Suggested fix

Treat `done` like `open` (LWW by `lastModified`) or as a conflict field. Treat a move as one unit: take `parentId` and the parent `children` lists from the same side, chosen by the node's newest `lastModified`. Better long term: per-field timestamps (see sync-06 and data-05).

## Tests

Unit tests on `mergeDocuments` for done-vs-text and move-vs-edit cases.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Related:** —
