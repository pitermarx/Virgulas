# Hosted Supabase auth configuration, and configurable backends

- **Priority:** P1
- **Severity:** Medium
- **Confidence:** code-read of `config.toml`; hosted settings not inspected
- **Spec impact:** none for hardening; configurable backends need a SPEC and CSP decision

## Summary

The shipped Supabase auth settings are weak for a password that gates the ciphertext, and the
backend origin is fixed at build time against the CSP, which leaves self-hosters without a
documented build-time option.

Evidence and the remediation plan are kept out of the public repository until the hosted settings
are reviewed; `docs/SECURITY.md` carries the public summary.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0B — Quick wins (operations and CI)](README.md#phase-0b)
- **Size:** M · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** —
- **Unblocks:** [dep-02](dep-02-supabase-client-footprint.md), [priv-03](priv-03-account-erasure-is-manual.md), [roadmap-05](roadmap-05-multi-document-workspaces.md)
- **Its decision changes how these are built:** [dep-02](dep-02-supabase-client-footprint.md), [growth-01](growth-01-publicity-and-monetisation.md), [priv-03](priv-03-account-erasure-is-manual.md), [scale-01](scale-01-open-signup-storage-abuse.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Shaped by:** —
- **Related:** [scale-01](scale-01-open-signup-storage-abuse.md)
