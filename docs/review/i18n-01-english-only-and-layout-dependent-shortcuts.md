# English-only UI, hard-coded locale and layout-dependent shortcuts

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** localisation is a product decision

## Description

- All user-facing strings are literals inside the Preact templates, with no message catalogue, so translating means editing logic files.
- `formatDueDate` hard-codes `en-US` month names; `<html lang="en">` is fixed and there is no `dir` handling for right-to-left text in nodes.
- Shortcuts are matched on the produced character (`Ctrl+Alt+${e.key}`). On Windows, AltGr reports `Ctrl+Alt`, and many layouts produce characters for AltGr plus a letter, so those shortcuts do not fire there. With Caps Lock on, `e.key` is uppercase and the lowercase cases do not match. Layouts other than US QWERTY are not covered by tests.

## Evidence

- [source/js/meta.ts](../../source/js/meta.ts#L103)
- [source/js/shortcuts.ts](../../source/js/shortcuts.ts#L368)
- [source/index.html](../../source/index.html)

## Suggested fix

Short term: use `Intl.DateTimeFormat(undefined, …)` for due dates, set `dir="auto"` on node text, match shortcuts on `e.code` (physical key) for letter chords and normalise case, and document shortcuts that need a US layout. Only if translation is wanted: extract strings into one `messages.ts` keyed catalogue and pick the language from `navigator.language` with a manual override.

## Tests

Unit tests for the key-chord matcher with `code`/`key` combinations (AltGr, Caps Lock); a date-format test with a non-English locale.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** M
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [web-05](web-05-small-cleanups.md)
