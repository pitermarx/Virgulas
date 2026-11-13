# Sync anti-rollback with monotonic revisions (review the data model first)

- **Priority:** P1 (largest remaining security item; give it its own session)
- **Severity:** High design item
- **Confidence:** code-read
- **Spec impact:** SPEC, envelope format (`v3`) and schema all change; needs a decision before any code

## Summary

Merge resolves conflicts with client wall-clock `lastModified` and trusts the `updated_at`
the client itself writes, so there is no anti-rollback protection: a skewed or forged clock wins
conflicts and a compromised server can replay an older ciphertext. The fix is a monotonic
revision carried inside the encrypted payload and bound as authenticated data.

Evidence, attack analysis and the remediation plan are kept out of the public repository until
the item is closed; `docs/SECURITY.md` carries the public summary of the open security work.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** L · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [sec-06](sec-06-no-aad-on-ciphertext.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Unblocks:** [roadmap-05](roadmap-05-multi-document-workspaces.md)
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [dur-03](dur-03-no-versioned-backups.md), [sec-06](sec-06-no-aad-on-ciphertext.md)
- **Related:** —
