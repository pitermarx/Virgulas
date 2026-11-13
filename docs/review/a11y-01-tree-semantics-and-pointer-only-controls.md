# The outline has no tree semantics, and several controls are pointer-only

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none; SPEC ROADMAP already lists "ARIA tree roles, screen-reader announcements for focus, collapse, and zoom changes"

## Description

- Nodes are nested `div`s with no `role="tree"`, `treeitem`, `group`, `aria-level` or `aria-expanded`, so a screen reader cannot tell depth or collapsed state.
- The bullet (zoom) and the collapse arrow are `span`s with `onClick`: not focusable, no role, no key handler, no accessible name. Keyboard users rely on global shortcuts.
- Rendered text and description are `div`s that turn into inputs on click, so browse-mode screen-reader users cannot activate them.
- Only the search counter and sync state use live regions; zoom, collapse and moves are not announced.
- The bullet is `draggable="true"` with no keyboard alternative.

## Evidence

- [source/js/ui.ts](../../source/js/ui.ts#L399) (`bullet`)
- [source/js/ui.ts](../../source/js/ui.ts#L417) (`collapse-toggle`)
- [docs/SPEC.vmd](../SPEC.vmd) (ROADMAP, ACCESSIBILITY)

## Suggested fix

Adopt the WAI-ARIA tree pattern: one tab stop with roving `tabindex`, `role="tree"` / `treeitem` / `group`, `aria-expanded`, `aria-level`, `aria-setsize`/`aria-posinset`. Turn the bullet and arrow into real `<button>`s (arrow with `aria-expanded`). Add a polite live region for zoom, collapse, move and task changes.

## Tests

Playwright `getByRole('tree')` and `treeitem` assertions plus the axe checks from a11y-04.

<!-- roadmap -->
## Roadmap position

- **Phase:** [7 — Outline UI: performance and accessibility](README.md#phase-7)
- **Size:** L
- **Do these first:** [a11y-02](a11y-02-dialog-focus-management.md), [a11y-04](a11y-04-no-automated-accessibility-testing.md)
- **Unblocks:** [roadmap-02](roadmap-02-drag-and-drop-reordering.md), [roadmap-04](roadmap-04-tags-and-mentions-autocomplete.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
