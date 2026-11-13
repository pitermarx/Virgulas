# Whole-document transfer on every sync, and a double download at startup

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none for the startup fix; a delta protocol is a larger design change

## Description

- Every save uploads the entire base64 ciphertext (about 33% larger than the gzip+AES bytes). Every pull downloads all of it.
- `getAuthBootstrap` calls `remoteSync.read()` only to compute `hasRemoteData`, then `unlockRemote` reads the same row again.
- The `data` column is `text`; ciphertext does not compress, so Postgres TOAST compression is wasted effort.

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L849) (bootstrap read)
- [source/js/sync.ts](../../source/js/sync.ts#L120) (`read`)
- [supabase/schemas/outlines.sql](../../supabase/schemas/outlines.sql)

## Suggested fix

1. Quick: use a `select('updated_at')` (or a head request) for `hasRemoteData`, and cache the first full read for `unlockRemote`.
2. Schema: `alter column data set storage external` to skip TOAST compression.
3. Larger: store the blob in Supabase Storage for big documents, or split into per-subtree encrypted chunks so only changed chunks upload.

## Tests

Playwright with a request counter: startup in Remote mode performs one full read.

<!-- roadmap -->
## Roadmap position

- **Phase:** [3 — Stop data loss and fix sync on the current model](README.md#phase-3)
- **Size:** S
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Unblocks:** —
- **Its decision changes how these are built:** [roadmap-01](roadmap-01-queued-background-sync.md), [roadmap-05](roadmap-05-multi-document-workspaces.md), [scale-02](scale-02-transfer-cost-model.md)
- **Shaped by:** —
- **Related:** —
