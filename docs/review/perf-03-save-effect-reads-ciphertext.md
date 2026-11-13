# The save effect reads the whole ciphertext from localStorage on every keystroke

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

The autosave effect subscribes to `dirtyWrites`, so it re-runs on every change. Each run calls `localEncryptedData.get().salt`, which reads the entire stored ciphertext and slices it just to get the salt. It also re-arms timers each time.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L467)

## Suggested fix

Keep the salt in memory after unlock (the code already tracks it in `sync.ts`), or read just the prefix once per session. Separate the "arm the timer" effect from the "resolve credentials" work.

## Tests

Unit test: repeated edits read `vmd_data_enc` at most once.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0A — Quick wins (code)](README.md#phase-0a)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
