# Simplification decisions (D9–D12)

Edge-case decisions for the stabilization phase, 2026-11-18. D1–D8 are the
data-model and delivery decisions in [README.md](README.md#decisions); these
are the ones the stabilization work itself needs settled first.

**All four were decided the same day, in review of this document.** The
outcomes are recorded in each section; the applying change is stacked on this
document's PR.

**How to decide here:** a lost edge case is acceptable only when the code it
removes is larger and riskier than the case it protected, and a feature is
never the price. A "drop" is user-visible, so the PR that implements it moves
the matching `docs/SPEC.vmd` lines in the same commit (Rule 1 pre-approval
applies: branch, PR, review).

The migration windows below are measured from the change dates in git, not
guessed.

## D9 — Legacy raw-base64 envelopes (310k iterations)

- **What:** payloads written before the `v2:` header existed decrypt at
  `LEGACY_ITERATIONS` ([crypto2.ts](../../source/js/crypto2.ts) §envelope).
- **Age:** v2 + 600k shipped 2026-09-23 (~2 months). A normal save upgrades a
  legacy envelope transparently (SPEC 218, 224–225).
- **Cost of keeping:** one branch on envelope parse, one constant, two tests.
  No runtime cost for current users.
- **Cost of dropping now:** anyone who has not opened the app since September
  can no longer decrypt their stored document — silent data loss for lapsed
  users.
- **Options:** A. Keep until the D4 v3 envelope lands (v3 already plans
  "keep `v2` decrypt, upgrade on next save" — the same machinery covers this).
  B. Drop now and require affected users to recover from an export.
- **Decided (2026-11-18): drop now (option B).** The only known client is the
  maintainer, so no real payload is stranded. A headerless value surfaces as a
  corrupt document instead of decrypting at a guessed 310k.

## D10 — Legacy `supabaseconfig` read-through

- **What:** `backendconfig` reads through the pre-seam `supabaseconfig` key so
  browsers configured before the storage seam keep their custom backend
  ([utils.ts:232](../../source/js/utils.ts), [storage.ts](../../source/js/storage.ts),
  SPEC 243).
- **Age:** the seam landed 2026-10-19 (~1 month).
- **Cost of keeping:** a wrapper slot with legacy-shape normalisation, a
  parallel "explicit only" accessor, and branches in the backend resolution.
- **Cost of dropping:** a browser configured before the seam forgets a custom
  backend once and falls back to the defaults. Config re-entry, not data loss.
- **Options:** A. Drop at the next minor release with a release note.
  B. Keep indefinitely. C. Drop now.
- **Decided (2026-11-18): drop now.** Stronger than the default — with the
  only known client being the maintainer, no release-note window is needed.
  The e2e fixture and the mock seed move to the current `backendconfig` shape
  in the same change, so no test keeps the legacy path alive.

## D11 — Legacy `sb-*-auth-token` session adoption

- **What:** sessions the Supabase SDK wrote before the seam are adopted into
  the store slot and the SDK key deleted
  ([supabaseBackend.ts:100](../../source/js/supabaseBackend.ts),
  [utils.ts:217](../../source/js/utils.ts) `clearLegacySupabaseSessions`).
- **Age:** adoption landed 2026-10-28 (~3 weeks).
- **Cost of keeping:** the adopt-and-delete path, the wipe-path cleanup, and
  two tests.
- **Cost of dropping:** those users are signed out once and sign in again.
- **Options:** A. Drop together with D10 in the same release note.
  B. Keep indefinitely.
- **Decided (2026-11-18): drop now.** The adoption path and its tests go; the
  wipe sweep (`clearLegacySupabaseSessions`) stays — it is priv-01 purge
  completeness (a stale `sb-*` key must not survive "Delete local data"), not
  migration.

## D12 — Multi-tab overwrites ([dur-01](dur-01-multi-tab-overwrites.md))

- **What:** two tabs of the same browser can silently overwrite each other's
  local and remote edits. The roadmap plans an M-size Phase 3 fix
  (an exclusive writer tab).
- **Decision actually needed:** does the stabilization phase *include* the
  Phase 3 sync/durability fixes, or defer them behind the Phase 5 data-model
  work? Accepting the case now removes an M item; the risk is silent loss in a
  realistic scenario (leaving a tab open).
- **Options:** A. Fix in this phase (small storage-event guard).
  B. Accept and document as a known limitation until Phase 5.
- **Decided (2026-11-18): fix in this phase (option A).** Silent data loss is
  not acceptable; the guard lands behind the landed save-session object.

## Checked and kept — verified as justified, no decision needed

- **CompressionStream capability check** ([utils.ts:57](../../source/js/utils.ts)):
  real dependency — plaintext is gzipped before encryption
  ([crypto2.ts:79](../../source/js/crypto2.ts)).
- **Multi-entry LRU derived-key cache** ([crypto2.ts:142](../../source/js/crypto2.ts)):
  the `cached()` composition alternates the local-slot and remote-row salts, and
  a passphrase rotated elsewhere puts a foreign salt in the row; a single-entry
  cache would re-derive per operation.
- **Safari best-effort durability override** ([durability.ts:4](../../source/js/durability.ts)):
  Safari tabs report best-effort even when persistence is granted.
- **Capture untrusted-input flow** ([capture.ts](../../source/js/capture.ts)):
  sec-01; the queue write only happens on the confirmed click.
- **meta.ts parser** ([meta.ts](../../source/js/meta.ts)):
  implements `docs/VMD.md` §8 normatively; the "edge cases" are the spec.

## Decision record

| # | Decision | Default | Decided |
| --- | --- | --- | --- |
| D9 | Legacy raw-base64 envelopes | Keep until D4 v3 | Drop now (2026-11-18) |
| D10 | `supabaseconfig` read-through | Drop at next minor release, release note | Drop now (2026-11-18) |
| D11 | `sb-*-auth-token` adoption | Drop with D10, one re-login | Drop now (2026-11-18); the wipe sweep stays |
| D12 | Multi-tab overwrites | Fix in this phase | Fix in this phase (2026-11-18) |
