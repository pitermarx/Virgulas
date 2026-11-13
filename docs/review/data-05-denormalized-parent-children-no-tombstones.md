# Denormalized tree and no tombstones

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** a model change needs SPEC and `modelVersion` handling

## Description

- Each node stores `parentId` and the parent stores `children[]`. Two sources of truth that the merge can desync (see data-02, data-04).
- Order is a plain array, so concurrent adds to the same parent always conflict.
- There are no tombstones. A deletion is inferred from "absent and unchanged since `lastSyncedAt`". It depends on wall-clock time and fails for fresh clients (`lastSyncedAt = 0` keeps every node; tracked in [SECURITY.md](../SECURITY.md)).
- `lastModified` is one timestamp per node, so field-level merging is impossible.

## Evidence

- [source/js/outline.ts](../../source/js/outline.ts) (node model, `serialize`, `deserialize`)
- [source/js/sync.ts](../../source/js/sync.ts) (`mergeDocuments`)

## Suggested fix

Incremental path:
1. Make `parentId` plus a sortable `position` key (fractional index) the source of truth, and derive `children` at load. Adding children then becomes a union.
2. Add tombstones (`deleted: <ts>`) kept for a retention window, so deletions do not depend on `lastSyncedAt`.
3. Add per-field timestamps (`text`, `description`, `done`, `parentId`, `position`).

Bump `modelVersion` and migrate on load.

## Tests

Property-style unit tests on `mergeDocuments`: merge is commutative and idempotent for random edit histories.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** L · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** —
- **Unblocks:** [roadmap-03](roadmap-03-node-linking.md), [sec-12](sec-12-sync-anti-rollback.md), [sync-06](sync-06-disjoint-field-edits-conflict.md), [ux-02](ux-02-no-undo.md)
- **Its decision changes how these are built:** [data-04](data-04-orphan-nodes-after-conflict-resolution.md), [roadmap-02](roadmap-02-drag-and-drop-reordering.md), [roadmap-03](roadmap-03-node-linking.md), [roadmap-05](roadmap-05-multi-document-workspaces.md), [sec-12](sec-12-sync-anti-rollback.md), [sync-06](sync-06-disjoint-field-edits-conflict.md), [ux-02](ux-02-no-undo.md), [ux-03](ux-03-conflict-resolution-granularity.md)
- **Shaped by:** —
- **Related:** —
