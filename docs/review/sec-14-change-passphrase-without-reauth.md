# `changePassphrase` does not require the current passphrase

- **Priority:** P1
- **Severity:** Medium
- **Confidence:** code-read; listed under "CI and process hardening" in [SECURITY.md](../SECURITY.md)
- **Spec impact:** SPEC describes the change flow; adding re-entry is an addition

## Description

`changePassphrase(newPassphrase)` needs only an unlocked session. An unattended unlocked tab (and there is no idle lock, sec-11) lets anyone rotate the key. In Remote mode the rotation uploads the re-encrypted document with a new salt, so other devices stop decrypting, and a stale device may even overwrite it back. Account email and password changes have the same weakness (`secure_password_change` is off, sec-13).

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L1058) (`changePassphrase`)
- [source/js/app.ts](../../source/js/app.ts#L284) (`submitChangePassphrase`)

## Suggested approach

Ask for the current passphrase and verify it by decrypting the stored envelope (the cached key does not count) before accepting the new one. For Remote mode, re-authenticate with the account password for email and password changes. Show a clear warning that other devices will need the new passphrase, and write the new row only after the local write succeeds. Keep the previous ciphertext recoverable for a short time (dur-03).

## Tests

Unit test: wrong current passphrase rejects and nothing is written. Playwright: the change flow prompts for it.

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** S · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [dur-03](dur-03-no-versioned-backups.md)
- **Related:** [sec-11](sec-11-no-idle-auto-lock.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
