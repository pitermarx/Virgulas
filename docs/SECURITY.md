# Security register

Known security concerns for Virgulas, the rationale behind the mitigations already in
place, and what is deliberately accepted.

It comes from a red-team review of the codebase (app shell, crypto, sync, Supabase
schema and policies, service worker, build and CI). The source of truth for behaviour
is [`SPEC.vmd`](./SPEC.vmd); this document is the source of truth for *open security
work*.

Status legend: **Fixed** (mitigation shipped), **Open** (tracked here), **Accepted**
(intentional residual risk).

---

## Fixed

| Item | Mitigation | Where |
| --- | --- | --- |
| Third-party analytics had full origin access | Umami tracker is the only remote script, pinned with a `sha384` SRI hash + `crossorigin="anonymous"`; CSP `script-src` allow-lists only `'self'` and that host | `source/index.html` |
| Production trusted `window.supabase.createClient` | The seam is compiled out: `__TEST_HOOKS__` is `false` in production, so the bundle never reads the global. `bun run dev:test` enables it for Playwright only | `source/js/sync.ts`, `scripts/build-bun.mjs` |
| No Content-Security-Policy | Strict meta CSP, no inline script or inline event handlers (modals and service-worker registration moved into the bundle). Production builds pin `connect-src` to the real Supabase origin and drop localhost + `*.supabase.co` | `source/index.html`, `scripts/csp.ts` |
| DOMPurify allow-list was not enforced | `USE_PROFILES` removed; explicit `ALLOWED_TAGS`/`ALLOWED_ATTR` actually apply, so raw HTML cannot inject `form`, `input`, `style`, `class`, or `id` | `source/js/markdown.ts` |
| Remote media auto-load beacons | Images load normally but every rendered image is hardened with `referrerpolicy="no-referrer"`, `loading="lazy"`, `decoding="async"`; unsafe `src` values are dropped; handlers/`srcset` stripped | `source/js/markdown.ts` |
| Biometric seal outlived the session | `signOut()` and `reset()` call `biometrics.forget()`, so sign-out, mode switch, and local purge revoke the device-local wrapped passphrase | `source/js/persistence.ts` |
| Dev-server path traversal | `resolveStaticPath` compares a fully resolved path against the root (plus separator) and rejects NUL bytes | `scripts/static-path.ts`, `scripts/serve-bun.mjs` |
| Source maps shipped to production | `bun run build` and the deploy pipeline pass `--no-sourcemap`, and CI fails if `dist/js/app.js.map` exists. Local `dev` keeps maps | `package.json`, `.github/workflows/ci.yml` |
| KDF parameters below guidance and unversioned | Payloads carry a `v2:<iterations>:<base64(iv||ct)>` envelope (legacy raw base64 still decrypts at 310k); default raised to 600,000 PBKDF2-HMAC-SHA256 iterations, and the normal save re-encrypts older envelopes transparently. The derived key is cached for the unlocked session so autosave does not re-run the KDF. New passphrases must be at least 10 characters; existing shorter ones still unlock | `source/js/crypto2.ts`, `source/js/persistence.ts` |
| `deserialize` parent lookup resolved inherited properties | Node map uses `Object.create(null)`, so `constructor`/`toString`/`__proto__` parents no longer pass validation | `source/js/outline.ts` |
| Base64 helpers broke on large documents | Chunked `toBase64`/`fromBase64`, so a large payload no longer throws `RangeError: Maximum call stack size exceeded` on save/unlock | `source/js/crypto2.ts` |
| No self-service erasure (GDPR/right-to-be-forgotten) | Scoped `Users can delete their own outline` DELETE policy (`auth.uid() = user_id`) plus the Options → **Delete account** path that removes the `outlines` row, clears the local session and signs out | `supabase/schemas/outlines.sql`, `source/js/sync.ts`, `source/js/persistence.ts` |
| No CDN security headers; clickjacking possible | A Cloudflare response-header transform ruleset plus Always Use HTTPS is applied by `bun run cf:headers` from the deploy job (HSTS, `nosniff`, `frame-ancestors 'none'`, `X-Frame-Options`, Referrer-Policy, Permissions-Policy, COOP, CORP); the deploy fails if the ruleset cannot be applied, and `/.well-known/security.txt` is published | `scripts/cloudflare-headers.mjs`, `.github/workflows/ci.yml`, `source/.well-known/security.txt` |

**Analytics maintenance.** The Umami tracker is the only remote script. When it is upgraded,
recompute the `sha384` digest, update the `integrity` attribute and the `script-src` allow-list in
`source/index.html`, and keep this table accurate. The digest is deliberately committed so a new
tracker build cannot ship silently.

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

### Supabase schema, grants, and RLS gaps

**Evidence:** `supabase/schemas/outlines.sql`. RLS scopes DML with
`(select auth.uid()) = user_id`.

**Impact:** `updated_at` is entirely client-controlled (no server trigger), so a buggy
or hostile client can set arbitrary timestamps.

**Remediation (remaining):** add a server-side `updated_at` trigger and stop trusting
the client value. This must land together with the client change that stores the
server-returned `updated_at` as `vmd_sync_ts`: today `lastSyncedAt` and
`lastCompletedRemotePush.updatedAt` are client clock, so switching only the server to
`now()` would make a client read its own push as a remote update under clock skew.
Tracked as part of *Sync is clock-trusting with no anti-rollback*.

**Resolved:** self-service erasure ships (a scoped `Users can delete their own outline`
DELETE policy plus the Options → **Delete account** path; the browser cannot remove the
`auth.users` record itself, so removing the account identity still needs the service
role). `anon` and `authenticated` no longer hold `TRUNCATE`, `TRIGGER`, or `REFERENCES`,
and `data`/`salt` are bounded by `outlines_data_size_check` (< 16 MiB) and
`outlines_salt_size_check` (< 1 KiB) — schema updated and migration
`20260929123251_harden-outlines-grants-and-size` generated.

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

## Accepted / residual

- **Analytics runs same-origin with DOM access.** SRI pins which code runs, not what a
  legitimate Umami build can read. CSP also allow-lists the whole analytics host, so an
  injected `<script src="https://um.vps.pitermarx.com/…">` would load; closing that
  fully would need self-hosting the tracker or `script-src 'self' 'sha384-…'` with its
  narrower browser support. Accepted for now.
- **Plaintext device-local metadata.** The quick-capture queue (`vmd_inbox_queue`,
  capped at 500 × 10 KB), the last username/email, theme, mode, scheduled-window setting,
  inbox node name, Supabase config, and sync timestamps are stored unencrypted. The encrypted
  document payload (`vmd_data_enc`, which also carries the salt) is the only ciphertext at rest.
  The full list is in `docs/SPEC.vmd` → ENCRYPTION → PLAINTEXT METADATA.
- **Service worker** serves the app bundle stale-while-revalidate; a stale or
  compromised `app.js` persists until revalidation. Cache versioning is automated.
- **`img-src … http:`** in the CSP is mostly moot: on an https origin the browser
  blocks mixed content anyway.
- **No unlock throttling.** The document passphrase is verified only on-device
  (PBKDF2 → AES-GCM); the server never sees it and could not rate-limit it without
  becoming a guess oracle, and Local/File/Memory modes have no server at all. Any
  client-side delay is trivially bypassed (reload, or copy the ciphertext and
  brute-force offline), so the real brakes are PBKDF2 cost and passphrase entropy.
  Accepted rather than implemented.
- **Node ids come from `Math.random()`.** `randomId` in `crypto2.ts` seeds outline,
  inbox, and zoom identifiers. They are internal handles: they never guard access, they
  are not trusted by the sync server (the payload is ciphertext, and the id lives inside
  it), and a guessed id only points at a node in a document the attacker cannot read.
  Predictability is a non-issue here, so this is accepted rather than fixed.

## Reporting

Security issues should not be filed as public issues. Contact the maintainer directly
(email in the repository profile) with reproduction steps.
