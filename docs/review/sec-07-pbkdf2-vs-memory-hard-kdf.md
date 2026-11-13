# PBKDF2 is GPU-friendly; consider a memory-hard KDF

- **Severity:** Low
- **Confidence:** n/a (design trade-off)
- **Spec impact:** SPEC mandates PBKDF2; Rule 6 forbids third-party crypto libraries

## Description

600,000-iteration PBKDF2-HMAC-SHA256 meets the OWASP minimum but is cheap to parallelise on GPUs. The real brakes against offline guessing are the passphrase length (minimum 10) and entropy. Argon2id or scrypt would need a WASM implementation, which conflicts with Rule 6.

## Evidence

- [source/js/crypto2.ts](../../source/js/crypto2.ts)

## Suggested fix

Cheapest wins within the rules: raise the iteration count periodically (the envelope already supports it), add a passphrase strength meter and encourage multi-word passphrases, and show the estimated cost in Options. Revisit Argon2id only if the platform gains a native Web Crypto primitive, or if Rule 6 is relaxed on purpose.

## Tests

None required for the guidance items; a unit test for the strength meter if it is added.

<!-- roadmap -->
## Roadmap position

- **Phase:** [4 — Decide and measure](README.md#phase-4)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
