# Several modules exceed the project's own size guidance

- **Severity:** Medium
- **Confidence:** measured (line counts including blank lines, 2026-11-18: `persistence.ts` 830; `lockScreen.ts` 668; `shortcuts.ts` 462; `options.ts` 424; `components/outline.ts` 390; `syncEngine.ts` 386; `trailbaseBackend.ts` 364)
- **Spec impact:** none (AGENTS.md says to split files over ~350-450 lines that mix concerns)
- **Status:** partly fixed. `app.ts` (now 305), `sync.ts` (now 140) and the former
  `ui.ts` are within guidance after the lock-screen, capture, options, backend,
  merge, engine and component extractions landed, and `outline.ts` (871) became
  `outline.ts` 434 + `node.ts` 200 + `vmdEditor.ts` 153 + `treeOps.ts` 93 +
  `navigation.ts` 66. The files below are what remains.

## Description

- `persistence.ts` (830) still mixes the session lifecycle, store construction, unlock/sign-in flows and the Remote save edge, even after the File store, save pipeline, sync engine and intro loader moved out.
- `lockScreen.ts` (668) holds the unlock, sign-up/reset, wizard and secure-storage-prompt surfaces in one file.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts)
- [source/js/lockScreen.ts](../../source/js/lockScreen.ts)

## Suggested fix

Keep splitting along the seams that worked for `app.ts`, `sync.ts` and `outline.ts` (one responsibility per module, Rule 7 boundaries intact), largest first: `persistence.ts`, then `lockScreen.ts`.

## Tests

No new behaviour; the existing unit and e2e suites must stay green.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** L
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
