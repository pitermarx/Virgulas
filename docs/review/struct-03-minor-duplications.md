# Smaller duplications

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none, except the VMD escape item which touches parsing semantics

## Description

- `parseInt(store.syncTs.get('0') || '0') || 0` is repeated in `persistence.ts` although `getLastSyncedAt()` exists in `sync.ts`.
- IndexedDB open/get/put/delete helpers exist twice: the filesystem handle store in `persistence.ts` and the key-value store in `biometrics.ts`.
- `biometrics.ts` has its own base64 helpers beside the chunked ones in `crypto2.ts`.
- `markdown.ts` has two near-identical text-node walkers (`decorateSearchTokens`, `decorateMetaChips`).
- `outline.ts` has two VMD line parsers (`setVMD`, `setRootVMD`) with different description escapes (`` ` `` versus `\`); the earlier notes flagged this as a likely bug against the SPEC.
- `moveUp`/`moveDown` and `next`/`prev` are mirrored implementations.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts), [source/js/biometrics.ts](../../source/js/biometrics.ts), [source/js/markdown.ts](../../source/js/markdown.ts), [source/js/outline.ts](../../source/js/outline.ts)

## Suggested fix

Extract a small `idb.ts` helper, reuse `getLastSyncedAt()`, share the base64 helpers from `crypto2.ts` (keeping the Rule 7 exception for biometrics key wrapping), unify the walkers, and settle the VMD escape convention by asking for a SPEC ruling first.

## Tests

Existing suites; add a test for whichever VMD escape the SPEC confirms.

<!-- roadmap -->
## Roadmap position

- **Phase:** [2 — Make persistence and sync changeable](README.md#phase-2)
- **Size:** S
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-10](sec-10-markdown-sanitizer-roundtrip.md)
- **Related:** —
