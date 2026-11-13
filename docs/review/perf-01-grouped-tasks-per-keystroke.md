# Task selectors rescan the whole outline on every keystroke

- **Severity:** Medium
- **Confidence:** code-read; costs measured on a 20k-node probe (`getAllTasks` about 4 ms before the rest of the work)
- **Spec impact:** none

## Description

The status toolbar always reads `pendingTaskCount` and `hasOverdueTasks`, so `groupedTasks` stays live even when the tasks panel is closed. It subscribes to `dirtyWrites`, which changes synchronously on every mutation. Each keystroke runs `[...map.values()].filter`, an ancestor walk per task (`isWithinZoom`, `breadcrumb`), `parseMeta` per task, and two sorts.

## Evidence

- [source/js/tasks.ts](../../source/js/tasks.ts#L54)
- [source/js/outline.ts](../../source/js/outline.ts#L981) (`getAllTasks`)

## Suggested fix

Recompute from the debounced `outline.version` instead of `dirtyWrites` for the badge counts. Maintain the task set incrementally (a `Set` updated on `done` changes), and compute the grouped list lazily only when the panel is open. Compute breadcrumbs for visible rows only.

## Tests

A unit benchmark guard: 20k nodes with 7k tasks, assert a keystroke update stays under a set budget.

<!-- roadmap -->
## Roadmap position

- **Phase:** [7 — Outline UI: performance and accessibility](README.md#phase-7)
- **Size:** M
- **Do these first:** [perf-08](perf-08-document-size-limits-and-old-devices.md)
- **Unblocks:** [roadmap-03](roadmap-03-node-linking.md), [roadmap-04](roadmap-04-tags-and-mentions-autocomplete.md)
- **Its decision changes how these are built:** [roadmap-04](roadmap-04-tags-and-mentions-autocomplete.md)
- **Shaped by:** —
- **Related:** —
