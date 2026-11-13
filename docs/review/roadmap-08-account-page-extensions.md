# Account page extensions (MFA, recovery code, sessions)

- **Priority:** P3 (product follow-up)
- **Type:** feature
- **Spec impact:** SPEC (account page); a new section or an extension of the existing account one

## Description

The account page already ships the core of the work plan that used to live in `plan.md`: storage
mode remembered across visits, account info, email and password change, passphrase change,
export/import, biometric unlock enrolment, and delete account. Four parts of that design were
never built:

- **MFA (TOTP)** — enroll, confirm and disable through the Supabase auth client. It protects the
  account, which gates the ciphertext, without touching the encryption passphrase.
- **Recovery code** — issued at setup or on demand, the only way back into a document whose
  passphrase is forgotten (the server can never reset it). Locally stored and wrapped; a
  cross-device code would need a server column.
- **Sign out everywhere, and a trusted-device list** — needs a small Edge Function with the
  service role, so it is a backend addition. It is also the server-side half of priv-03.
- **Payments placeholder** — deferred until monetisation is decided (growth-01); no UI beyond a
  disabled section.

## What it depends on

- priv-03 for the account deletion path (the same service-role function can erase the auth record).
- growth-01 before any payments UI.
- dur-03 if the "reset and lose data" path should stay recoverable for a window.

## Suggested approach

Build MFA and the recovery code first: both are client-side and both close a real lockout risk.
Treat sign-out-everywhere as its own change because it adds an Edge Function, a deploy step and a
new failure mode for a feature that must never lose data.

## Tests

Unit tests for the recovery-code wrap/unwrap and for the MFA state machine; Playwright for the
enrolment flow against the mocked auth client; a manual pass on a real authenticator.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 - Features](README.md#phase-9)
- **Size:** M
- **Do these first:** [priv-03](priv-03-account-erasure-is-manual.md)
- **Unblocks:** -
- **Its decision changes how these are built:** [growth-01](growth-01-publicity-and-monetisation.md)
- **Shaped by:** [dur-03](dur-03-no-versioned-backups.md)
- **Related:** [roadmap-05](roadmap-05-multi-document-workspaces.md), [sec-14](sec-14-change-passphrase-without-reauth.md)
