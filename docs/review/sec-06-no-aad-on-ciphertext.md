# Ciphertext is not bound to its context (no AAD)

- **Priority:** P1
- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** SPEC, envelope format (`v3`)

## Summary

AES-GCM is called without additional authenticated data, so the envelope header, the user id and
a document revision are not authenticated. The server cannot forge content; it can replay an
older ciphertext or move a row.

Evidence, attack analysis and the remediation plan are kept out of the public repository until
the item is closed; `docs/SECURITY.md` carries the public summary of the open security work.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** M · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Unblocks:** [sec-12](sec-12-sync-anti-rollback.md)
- **Its decision changes how these are built:** [sec-12](sec-12-sync-anti-rollback.md)
- **Shaped by:** —
- **Related:** —
