# No versioned backups or snapshots

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** a new feature; needs SPEC and schema decisions

## Description

Every save overwrites the single stored copy: the `vmd_data_enc` localStorage key and the single `outlines` row. If a bug writes a bad document (data-02 is an example), or a user deletes content by mistake, there is no earlier version to return to. Undo is not implemented (see ux-02). On the hosted Supabase free plan there are no automatic database backups, so the server copy is not a backup either. [SECURITY.md](../SECURITY.md) notes the single mutable row.

This also covers the roadmap item "single mutable remote row": `resetRemoteData` and `changePassphrase` overwrite the one `outlines` row with no history, so a reset or key rotation cannot be undone. Soft-delete or keep the previous row (the `outline_revisions` idea below) so both operations stay recoverable for a short window (see also sec-14).

## Evidence

- [source/js/persistence.ts](../../source/js/persistence.ts#L186)
- [supabase/schemas/outlines.sql](../../supabase/schemas/outlines.sql)

## Suggested fix

- Local: keep the last N encrypted snapshots (for example daily for 7 days, plus the last 5 saves) in IndexedDB, with a "Restore previous version" list in Options.
- Remote: add an `outline_revisions` table (`user_id`, `revision`, `data`, `salt`, `created_at`) written by a trigger on update, pruned to a small window, with the same RLS policies. This pairs with the revision column in sync-04.
- Prompt for an `.vmd` export on a schedule.

## Tests

Unit tests for snapshot rotation and restore; Playwright for the restore flow.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** L · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Unblocks:** [roadmap-05](roadmap-05-multi-document-workspaces.md)
- **Its decision changes how these are built:** [dur-04](dur-04-destructive-actions-without-safety-net.md), [sec-12](sec-12-sync-anti-rollback.md), [sec-14](sec-14-change-passphrase-without-reauth.md), [ux-02](ux-02-no-undo.md)
- **Shaped by:** —
- **Related:** [compat-02](compat-02-file-mode-chromium-only.md)
