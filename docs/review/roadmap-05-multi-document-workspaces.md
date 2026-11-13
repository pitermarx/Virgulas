# Multi-document workspaces

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC, storage keys and the Supabase schema all change

## Description

Save and switch between several named outlines instead of one monolithic tree.

## What blocks it today

- **Storage:** one `vmd_data_enc` key, one `outlines` row per user (primary key `user_id`), one remote sync state (`vmd_sync_ts`), one inbox target. Every module assumes a single document.
- **Sync model:** whole-document upload (sync-07) means each extra document multiplies the transfer cost and the conflict surface.
- **Quota:** localStorage is about 5 MB in total, so several documents need IndexedDB.
- **Singletons:** `outline` is one module-level instance (struct-07), so switching documents means resetting and reloading it, and the undo stack (ux-02) must be per document.

## Suggested approach

1. Move local storage to IndexedDB with a document table (`id`, `name`, `updatedAt`, ciphertext) and migrate the existing key.
2. Schema: change `outlines` primary key to `(user_id, doc_id)` plus a `name_enc` column (document names encrypted with the same key), and add a per-document revision (sync-04). Update `supabase/schemas` and generate the migration.
3. Use one passphrase and salt per account; derive per-document keys or reuse one key with unique IVs.
4. Add a document switcher UI with rename, delete and the active document in the URL hash or path (the hash currently carries zoom).
5. Make the inbox target one chosen document.

Do the revision and sync work (sec-12, struct-02) before this, otherwise every sync bug is multiplied per document.

## Tests

Unit tests for migration of the single-document layout; Playwright for create, switch, rename, delete.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** L · needs a SPEC.vmd decision first (Rule 1)
- **Do these first:** [dur-03](dur-03-no-versioned-backups.md), [sec-12](sec-12-sync-anti-rollback.md), [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md), [struct-07](struct-07-module-level-mutable-state.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md), [ux-02](ux-02-no-undo.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [sync-07](sync-07-full-document-transfer-and-double-download.md)
- **Related:** —
