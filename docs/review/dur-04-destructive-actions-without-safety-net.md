# Destructive actions have no safety net

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** SPEC says import "replaces the document"; adding a confirmation or backup is an addition, not a contradiction

## Description

- **Import .vmd** replaces the whole document immediately, with no confirmation and no automatic backup. In Remote mode the replacement is then synced to every device.
- **Switching mode** from Local with data asks for confirmation but does not offer to export first, then clears the encrypted data.
- **Pasting multi-line text** into a node replaces its children (`setVMD` deletes them first) with no undo.
- **Delete local data** is a single `confirm()`.

## Evidence

- [source/js/app.ts](../../source/js/app.ts#L335) (`importDoc`)
- [source/js/app.ts](../../source/js/app.ts#L433) (`requestChangeMode`)
- [source/js/outline.ts](../../source/js/outline.ts) (`setVMD`)

## Suggested fix

Before import, mode switch and purge, offer "Download a backup first" and snapshot the current document (dur-03). Show the imported node count and ask for confirmation. For paste, keep one step of undo (ux-02).

## Tests

Playwright: import prompts for confirmation, and cancelling leaves the document unchanged.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [dur-03](dur-03-no-versioned-backups.md)
- **Related:** —
