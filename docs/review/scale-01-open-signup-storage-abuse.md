# Open sign-up with no captcha lets anyone store data at your cost

- **Severity:** Medium
- **Confidence:** code-read of `config.toml`; hosted settings not inspected
- **Spec impact:** none

## Summary

With email confirmation and captcha off, throwaway accounts can be scripted with the public
publishable key and each can store up to the row limit at the project's cost.

Evidence and the remediation plan are kept out of the public repository until the hosted settings
are hardened; `docs/SECURITY.md` carries the public summary.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0B — Quick wins (operations and CI)](README.md#phase-0b)
- **Size:** S
- **Do these first:** —
- **Unblocks:** [growth-01](growth-01-publicity-and-monetisation.md)
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md)
- **Related:** [priv-03](priv-03-account-erasure-is-manual.md), [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md)
