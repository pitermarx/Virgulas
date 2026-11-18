# Several modules exceed the project's own size guidance

- **Severity:** Medium
- **Confidence:** measured (line counts including blank lines, 2026-11-18: `outline.ts` 871; `persistence.ts` 830; `lockScreen.ts` 668; `shortcuts.ts` 462; `options.ts` 424; `components/outline.ts` 390; `syncEngine.ts` 386; `trailbaseBackend.ts` 364)
- **Spec impact:** none (AGENTS.md says to split files over ~350-450 lines that mix concerns)
- **Status:** partly fixed. `app.ts` (now 305), `sync.ts` (now 140) and the former
  `ui.ts` are within guidance after the lock-screen, capture, options, backend,
  merge, engine and component extractions landed. The files below are what remains.

## Description

- `outline.ts` (871) mixes the document model, tree operations and search-tree generation.
- `persistence.ts` (830) still mixes the session lifecycle, store construction, unlock/sign-in flows and the Remote save edge, even after the File store, save pipeline, sync engine and intro loader moved out.
- `lockScreen.ts` (668) holds the unlock, sign-up/reset, wizard and secure-storage-prompt surfaces in one file.

## Evidence

- [source/js/outline.ts](../../source/js/outline.ts)
- [source/js/persistence.ts](../../source/js/persistence.ts)
- [source/js/lockScreen.ts](../../source/js/lockScreen.ts)

## Suggested fix

Keep splitting along the seams that worked for `app.ts` and `sync.ts` (one responsibility per module, Rule 7 boundaries intact), largest first: `outline.ts`, then `persistence.ts`, then `lockScreen.ts`.

## Tests

No new behaviour; the existing unit and e2e suites must stay green.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** L
- **Do these first:** [struct-07](struct-07-module-level-mutable-state.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
