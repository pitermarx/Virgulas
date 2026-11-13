# No idle auto-lock, and session tokens stay in localStorage

- **Priority:** P1
- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** SPEC

## Summary

An unlocked session never times out on its own, and the Supabase access and refresh tokens sit
in plaintext `localStorage`, where any same-origin script can read them until sign-out.

Evidence, attack analysis and the remediation plan are kept out of the public repository until
the item is closed; `docs/SECURITY.md` carries the public summary of the open security work.

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** M · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [struct-07](struct-07-module-level-mutable-state.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [a11y-02](a11y-02-dialog-focus-management.md), [sec-14](sec-14-change-passphrase-without-reauth.md)
