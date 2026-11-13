# Upsert has no compare-and-swap, so concurrent devices can overwrite each other

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** schema change (Rule 4: update `supabase/schemas/outlines.sql`)

## Description

Pull-before-push checks `updated_at` and then upserts, as two separate requests. Another device can write between them and its changes are overwritten. [SECURITY.md](../SECURITY.md) covers client-controlled clocks (see sec-12), but not this race.

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts#L130) (`upsert`)
- [supabase/schemas/outlines.sql](../../supabase/schemas/outlines.sql)

## Suggested fix

Add a `revision bigint not null default 0` column and a `before update` trigger that increments it and sets `updated_at = now()`. The client sends the revision it last saw and updates with `.eq('revision', seen)`; zero rows updated means "conflict, pull and merge again". Store the server-returned revision and timestamp as the sync marker. This also gives sec-12 the server-issued `updated_at` and revision it needs.

## Tests

Playwright with two contexts writing concurrently: the second write is rejected and merged, not lost.

<!-- roadmap -->
## Roadmap position

- **Phase:** [5 — Sync and data model v2](README.md#phase-5)
- **Size:** L
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md), [test-01](test-01-no-real-backend-e2e.md)
- **Unblocks:** [dur-03](dur-03-no-versioned-backups.md), [roadmap-01](roadmap-01-queued-background-sync.md), [roadmap-05](roadmap-05-multi-document-workspaces.md), [sec-06](sec-06-no-aad-on-ciphertext.md), [sec-12](sec-12-sync-anti-rollback.md)
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md)
- **Related:** [sec-14](sec-14-change-passphrase-without-reauth.md)
