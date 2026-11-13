# Dialog focus management is incomplete; the conflict dialog is not inert

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none

## Description

- The main content is `inert` only while Options or Quick capture is open. The sync-conflict dialog, which the SPEC calls blocking, does not set it, so keyboard focus and the global `document.onkeydown` handler still reach the outline behind it (also see ux-01).
- No dialog moves focus inside on open, traps Tab, or restores focus to the opener on close.
- The conflict dialog and the lock-screen sheet have no Escape or cancel path (appropriate for blocking, but then they must still own focus).
- The tasks panel is not modal but also not announced as a region.

## Evidence

- [source/js/app.ts](../../source/js/app.ts#L1337) (`inert=${…}`)
- [source/js/ui.ts](../../source/js/ui.ts#L818) (`ConflictModal`)

## Suggested fix

Extract one `Dialog` component (native `<dialog>` with `showModal()`, or `inert` on siblings plus a focus trap) that sets initial focus, restores focus on close and handles Escape according to a `dismissible` prop. Use it for Options, Quick capture, Conflicts and the tasks panel. Include the conflict state in the `inert` condition.

## Tests

Playwright: Tab never leaves an open dialog; closing returns focus to the trigger.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** M
- **Do these first:** —
- **Unblocks:** [a11y-01](a11y-01-tree-semantics-and-pointer-only-controls.md), [ux-01](ux-01-conflict-dialog-not-blocking.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [sec-11](sec-11-no-idle-auto-lock.md)
