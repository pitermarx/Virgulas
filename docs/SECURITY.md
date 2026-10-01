# Security register

Open security work for Virgulas. How to report a vulnerability, and the risks that are
deliberately accepted, are published in
[`source/.well-known/security.txt`](../source/.well-known/security.txt), which is what the
site serves at `/.well-known/security.txt`.

It comes from a red-team review of the codebase (app shell, crypto, sync, Supabase
schema and policies, service worker, build and CI). The source of truth for behaviour
is [`SPEC.vmd`](./SPEC.vmd); this document is the source of truth for *open security
work*.

---

## Open

### Sync is clock-trusting with no anti-rollback

**Evidence:** `source/js/sync.ts` — `mergeDocuments` resolves per-node conflicts with
client wall-clock `lastModified`, and `checkRemoteNewer` trusts the `updated_at`
value that the client itself writes on upsert (`remoteSync.upsert`, `persistence.ts`).
`lastSyncedAt` is `Date.now()` stored in `vmd_sync_ts`.

**Impact:**
- A device with a skewed or forged clock wins every conflict, or makes deletions look
  authoritative.
- A malicious or compromised server can **replay** an old ciphertext. On a fresh
  client (`vmd_sync_ts` absent → `lastSyncedAt = 0`) deleted nodes are resurrected
  from the old snapshot. It can also future-date `updated_at` to force constant pull
  churn, or withhold updates entirely (availability).

AES-GCM means the server cannot *forge* content, so this is an integrity/availability
issue, not a confidentiality one.

**Remediation:** carry a monotonic revision (server-issued sequence or hybrid logical
clock) inside the encrypted payload, bind it as AES-GCM additional authenticated data
together with `user_id`, and prefer it over wall-clock `lastModified`. Persist
`vmd_sync_ts` with the document lifecycle so a fresh client does not treat all remote
nodes as changed.

---

### Hosted auth configuration is weak

**Evidence:** `supabase/config.toml` — `minimum_password_length = 6`,
`password_requirements = ""`, `enable_confirmations = false`,
`secure_password_change = false`.

**Impact:** the account password gates access to the ciphertext; a 6-character password
with no composition requirement and no email confirmation is weak. (The encryption
passphrase is separate, now requires 10+ characters, and is the stronger of the two,
but users often reuse.)

**Remediation:** review the **hosted** project settings against these values: require
email confirmation, raise the minimum length, require mixed character classes, and
enable secure password change (re-authentication).

---

### CI and process hardening

- **`changePassphrase` does not require the current passphrase** — it only requires an
  unlocked session. Reasonable, but an unattended unlocked tab can rotate it. Consider
  re-entry.
- **Single mutable remote row.** `resetRemoteData`/`changePassphrase` overwrite the one
  `outlines` row with no version history. Consider a soft-delete or a backup row.

---