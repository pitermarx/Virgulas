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

**Evidence:** `supabase/schemas/outlines.sql` and
`supabase/migrations/*_initial-schema.sql`. The generated grants give `anon` and
`authenticated` `TRUNCATE`, `TRIGGER`, and `REFERENCES` (plus select/insert/update/
delete). RLS scopes DML with `(select auth.uid()) = user_id` and there is **no DELETE
policy** (safe default).

**Impact:**
- `TRUNCATE` is **not subject to RLS**. It is not reachable through PostgREST today, so
  this is defense-in-depth, but an over-broad grant is a foot-gun if a SQL path ever
  appears.
- No DELETE policy means no self-service erasure (GDPR/right-to-be-forgotten).
- `updated_at` is entirely client-controlled (no server trigger), and there is no size
  cap on `data`/`salt`, so a buggy or hostile client can set arbitrary timestamps or
  bloat the row.

**Remediation:**
1. `revoke truncate, trigger, references on public.outlines from anon, authenticated;`
2. Add a scoped DELETE policy if erasure is intended, plus a delete path in the UI.
3. Add a server-side `updated_at` trigger and stop trusting the client value.
4. Add `check (octet_length(data) < N)` to bound row size.

Update the schema file and generate a migration in the same change (AGENTS Rule 4).

---

### `randomId` uses `Math.random()`

**Evidence:** `source/js/crypto2.ts` — `Math.random().toString(36).substring(2, 10)`.
Used for outline node IDs (`outline.ts`) and inbox entry IDs (`inbox.ts`), which surface
in the URL hash.

**Impact:** low. Not a security boundary, but predictable IDs are avoidable and IDs are
used in UI/keyboard navigation.

**Remediation:** `crypto.randomUUID()` or `crypto.getRandomValues`-backed ids.

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

### No CDN security headers; clickjacking possible

**Evidence:** no `_headers`, `netlify.toml`, `vercel.json`, or equivalent. GitHub Pages
cannot set response headers, and `frame-ancestors` is **ignored when delivered in a
`<meta>` CSP**.

**Impact:** the app can be framed by another site (UI redressing — e.g. clickjacking
"Sign out", "Delete local data", or the unlock button). HSTS, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`, and `frame-ancestors` are all absent.

**Remediation:** front the app with Cloudflare (already used for cache purging in CI)
or another proxy that can set response headers, and configure
`Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS,
`Referrer-Policy: no-referrer`, and a restrictive `Permissions-Policy`. Keep the meta
CSP for directives that do work in meta.

---

### CI and process hardening

- **GitHub Actions are pinned to tags, not commit SHAs** (`actions/checkout@v7`,
  `oven-sh/setup-bun@v2`, …). A moved or compromised tag would execute in the release
  job (`contents: write`) and the Pages deploy job (`id-token: write`). Pin to SHAs;
  Dependabot is already configured for the `github-actions` ecosystem.
- **No unlock throttling.** Nothing limits passphrase attempts client-side; PBKDF2 cost
  is the only brake. Low risk (offline attacks dominate), but a small delay/backoff is
  cheap.
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
  capped at 500 × 10 KB), the last username/email, theme, mode, and sync timestamps are
  stored unencrypted. The encrypted document payload (`vmd_data_enc`) is the only
  ciphertext at rest. Documented in `README.md`.
- **Service worker** serves the app bundle stale-while-revalidate; a stale or
  compromised `app.js` persists until revalidation. Cache versioning is automated.
- **`img-src … http:`** in the CSP is mostly moot: on an https origin the browser
  blocks mixed content anyway.

## Reporting

Security issues should not be filed as public issues. Contact the maintainer directly
(email in the repository profile) with reproduction steps.
