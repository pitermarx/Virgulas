# Outline statistics

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC ROADMAP

## Description

Node count, word count and maximum depth, shown in Options or in a status-bar tooltip.

## What the code does today

`outline.getStats()` already computes word count, character count, maximum depth, collapsed and open counts and node count, and has unit tests. No UI calls it, which is why it appears as test-only code in struct-04. So this feature is mostly a view on existing logic.

## Suggested approach

- Show the stats in an Options section and a tooltip on the status bar; compute on demand (when Options opens or the tooltip is shown), not on every change. `getStats` walks the whole tree and allocates a snapshot per node (perf-04), which is fine on demand and wasteful per keystroke.
- Add task counts (pending, scheduled, done) from the existing selectors rather than a second scan.
- Decide the scope: whole document or the zoomed subtree.
- Once built, remove the "unused" entry for `getStats` from struct-04.

## Tests

The existing `getStats` unit tests; a Playwright test for the Options section.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
