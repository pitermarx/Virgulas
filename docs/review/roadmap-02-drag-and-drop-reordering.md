# Drag-and-drop reordering (solve multi-select move first)

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC ROADMAP

## Description

Add pointer reordering to complement the keyboard move. Add tests only when real drag handlers exist.

## What the code does today

- Bullets already have `draggable="true"` but no `dragstart`, `dragover` or `drop` handlers, so they suggest a capability that does not exist (also an accessibility smell, a11y-01). A browser drag of the bullet drags the element's text/image instead.
- Keyboard move (`Alt+↑/↓`) with a multi-selection calls `moveUp`/`moveDown` once per selected node. It works, but not as one operation: each node is moved separately, so a selection that mixes depths or is not contiguous has no defined result, and the whole selection is not one undo step (ux-02). Selection itself is limited to siblings (Shift+↑/↓).
- Moves bump `lastModified` on both parents and the node, and the merge treats `children` as one conflict field (data-02), so heavy reordering on two devices produces conflicts.

## Suggested approach

1. Define a single `outline.moveNodes(ids, targetParentId, index)` that moves a block, keeps relative order, rejects moving a node into its own subtree, and is one history entry. Make keyboard move and drag use it.
2. Add drop indicators and auto-scroll, handle touch (long-press to drag on mobile, where swipe already indents), and a keyboard alternative ("Move to…").
4. Remove `draggable="true"` until the handlers exist.

## Open questions

Should dragging a multi-selection across different parents be allowed?

## Tests

Unit tests for `moveNodes` (cycles, order, multi-select); Playwright drag tests once the handlers exist.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** L
- **Do these first:** [a11y-01](a11y-01-tree-semantics-and-pointer-only-controls.md), [ux-02](ux-02-no-undo.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md)
- **Related:** [roadmap-03](roadmap-03-node-linking.md)
