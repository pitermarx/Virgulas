# Several modules exceed the project's own size guidance

- **Severity:** Medium
- **Confidence:** measured (line counts including blank lines: `app.ts` about 1,400; `persistence.ts` about 1,100; `outline.ts` about 1,010; `ui.ts` about 800; `sync.ts` about 580)
- **Spec impact:** none (AGENTS.md says to split files over ~350-450 lines that mix concerns)

## Description

- `app.ts` is documented as "bootstrap" but holds about 45 module-level signals, the lock screen, the Options modal, the capture UI and the boot sequence.
- `persistence.ts` mixes the File System Access store, ciphertext storage, remote orchestration, the save pipeline and auth bootstrap.
- `sync.ts` mixes the Supabase client, merge algorithm, polling, status signals and conflict resolution.

## Evidence

- [source/js/app.ts](../../source/js/app.ts)
- [source/js/persistence.ts](../../source/js/persistence.ts)
- [source/js/sync.ts](../../source/js/sync.ts)

## Suggested fix

Split along existing seams, keeping Rule 7 boundaries:
- `persistence.ts` into `filesystem.ts`, `savePipeline.ts`, `bootstrap.ts`.
- `sync.ts` into `remoteClient.ts`, `merge.ts` (pure, easy to unit test), `poller.ts`.
- `app.ts` into `lockScreen.ts`, `optionsModal.ts`, `capture.ts`.

Do it behind the existing tests, one module per change (Rule 9).

## Tests

No new behaviour; the existing unit and e2e suites must stay green.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** L
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md), [struct-07](struct-07-module-level-mutable-state.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
