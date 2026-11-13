# Tags and mentions with autocomplete

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC ROADMAP

## Description

Autocomplete when typing `#` or `@`.

## What the code does today

`#tag` and `@mention` tokens are already recognised when rendering (markdown tokens become clickable chips that open search). There is no list of known tags, so autocomplete needs an index of every tag and mention in the document.

## Suggested approach

- Build the tag index with one pass over node text at load and update it incrementally on edits; do not rescan on every keystroke (perf-01).
- Show a popover near the caret while the node text input is focused; accept with Tab or Enter, dismiss with Escape. The text field is a plain `<input>`, so caret position is available through `selectionStart`.
- Make the popover accessible from the start (combobox pattern with `aria-activedescendant`, a11y-01).
- Rank by recent use and frequency, and treat tags case-insensitively like search does.
- Decide whether tag names are shared across documents once workspaces exist (roadmap-05).

## Open questions

Do mentions refer to people with a defined list, or are they free text?

## Tests

Unit tests for the index and token detection at the caret; Playwright for the popover and keyboard selection.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** M
- **Do these first:** [a11y-01](a11y-01-tree-semantics-and-pointer-only-controls.md), [perf-01](perf-01-grouped-tasks-per-keystroke.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [perf-01](perf-01-grouped-tasks-per-keystroke.md)
- **Related:** [roadmap-03](roadmap-03-node-linking.md)
