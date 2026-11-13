# Node linking (decide the storage design first)

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC ROADMAP; changes the VMD format (docs/VMD.md) if links are serialised

## Description

Internal references such as `[[node-id]]` with click-to-zoom navigation between notes. The note asks to think about efficient data storage in Supabase before building it.

## Things to decide first

- **Stable ids.** Node ids are random for Local and Remote documents but positional (`v_root_0_1`) for Memory and File documents because VMD carries no ids. A link target in a `.vmd` file would break when siblings are reordered. VMD would need an optional id marker (for example a trailing `^id`) written only for nodes that are link targets.
- **Dangling and moved links.** Deleting a node leaves broken links; sync tombstones (data-05) would make that detectable. Show links as broken, not as errors.
- **Backlinks.** Computing "who links here" means scanning every node's text. Keep an in-memory index built at load and updated incrementally (see perf-01 for the cost of whole-document scans per keystroke).
- **Supabase storage.** The server only holds one encrypted blob, so links add nothing server-side and need no schema change. Server-side indexing is impossible by design (end-to-end encrypted). The cost is on the client: a bigger document, and merge conflicts on the node text that contains the link.
- **Multi-document links** depend on roadmap-05.

## Suggested approach

Start with in-document links only: store the target id inside the node text token, add a click handler through the existing markdown token pipeline (the search token chips work the same way), and a link picker. Add the backlink index afterwards.

## Tests

Unit tests for parsing and index updates; Playwright for click-to-zoom and broken links.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** L · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [perf-01](perf-01-grouped-tasks-per-keystroke.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Related:** [roadmap-02](roadmap-02-drag-and-drop-reordering.md), [roadmap-04](roadmap-04-tags-and-mentions-autocomplete.md)
