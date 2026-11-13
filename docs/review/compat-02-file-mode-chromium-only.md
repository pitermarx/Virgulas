# File mode exists only in Chromium browsers

- **Severity:** Low
- **Confidence:** code-read (SPEC states "only available in browsers that support the API")
- **Spec impact:** a fallback is a product decision

## Description

File mode uses the File System Access API (`showOpenFilePicker` and `showSaveFilePicker`), which Firefox and Safari do not provide. Those users cannot keep a plain `.vmd` file in sync and are left with Local mode (storage can be evicted) or Remote mode (needs an account). The choice screen does not explain why File mode is missing beyond an error when it is picked.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L109) (`filesystemStorage`)
- [source/js/app.ts](../../source/js/app.ts#L454) (`pickMode`)
- [docs/SPEC.vmd](../SPEC.vmd)

## Suggested fix

Hide or disable the File option with an explanation when unsupported. Offer a "Manual file" fallback: open a `.vmd` through `<input type="file">`, edit in memory, and prompt to download on a timer or on `pagehide`. Where the Origin Private File System is available, it can also hold an automatic local backup (dur-03).

## Tests

Playwright with the picker APIs removed shows the explanation and the manual fallback.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** M
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [dur-03](dur-03-no-versioned-backups.md)
