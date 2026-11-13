# Resolving a `children` conflict can orphan nodes

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none

## Description

A `children` conflict is resolved by choosing the whole local or remote array. Nodes that exist only on the losing side stay in the document with a `parentId` pointing at the parent, but are absent from the parent's `children`. They are invisible, never reachable, still serialized and uploaded, and can accumulate. `deserialize` only validates that a parent exists, so it keeps them.

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts) (`resolveConflicts`)
- [source/js/outline.ts](../../source/js/outline.ts) (`validateNode` in `deserialize`)

## Suggested fix

Short term: when resolving, append nodes whose `parentId` is the parent but that are missing from the chosen array, instead of dropping them. Better: merge `children` as an ordered union (see data-05) so the choice is not needed. Add a repair pass in `deserialize` that re-attaches or reports unreachable nodes.

## Tests

Unit test: resolve a children conflict choosing each side and assert no node is unreachable from root.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Related:** —
