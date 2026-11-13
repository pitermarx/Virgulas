# Edits to different fields of the same node conflict

- **Severity:** Medium
- **Confidence:** verified (probe: local description edit plus remote text edit gave conflicts on both fields)
- **Spec impact:** SPEC currently specifies "per-field direct value comparison", so improving this changes the SPEC

## Description

The merge has no base snapshot, so a field that differs is assumed to be edited by both sides. If A edits only the description and B edits only the text, both fields conflict and the user must resolve each. The merge cannot tell who changed what.

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts#L310) (merge, "Both modified" branch)
- [docs/SPEC.vmd](../SPEC.vmd) (SYNC BEHAVIOUR)

## Suggested fix

Either keep per-field timestamps (see data-05), or store the last-synced document as a base and do a three-way merge: a field only conflicts when both sides differ from the base and from each other. The base can live in the encrypted local copy.

## Tests

Unit tests on `mergeDocuments`: disjoint field edits merge cleanly; same-field edits still conflict.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** L · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Unblocks:** [ux-03](ux-03-conflict-resolution-granularity.md)
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Related:** [ux-03](ux-03-conflict-resolution-granularity.md)
