# Virgulas — Work Plan

Three workstreams, in suggested order:

1. **WS1 — Persist the last persistence-mode choice** (fix "it keeps forgetting")
2. **WS2 — Admin page** (account management, info, passphrase reset options, payments placeholder)
3. **WS3 — Biometric / passkey unlock (Option B)**

E2E invariant for all workstreams: **no plaintext and no key material ever leave the client**. The server (`supabase` `outlines`) continues to store only `salt + AES-GCM ciphertext`. The account password stays separate from the encryption passphrase.

---

## WS1 — Persist the last persistence-mode choice

### Root cause (why it "keeps forgetting")

| # | Bug | Location |
|---|-----|----------|
| 1 | Memory mode is never remembered — `rememberMode('memory')` is not called on the memory unlock paths | `persistence.js` → `unlockMemory()`; `app.js` → `continueInMemory()` |
| 2 | `getAuthBootstrap()` has no `preferredMode === 'memory'` branch, so it falls through to data-signal heuristics and picks a different mode on next load | `persistence.js` → `getAuthBootstrap()` |
| 3 | Force sign-out lands on the remote login screen instead of the in-memory demo page | `app.js` → `submitSignOut()`; `persistence.js` → `signOut()` |
| 4 | Remote unlock mixes password + passphrase in one form; no staged "password first, then passphrase" | `app.js` → `LockScreen` / `submitUnlock()` |

### Desired behavior matrix

| Condition | Behavior on load |
|-----------|------------------|
| Never opened | Demo page, in-memory, read-only demo content, no persistence |
| Force sign-out | Same demo page, in-memory; "Sign in" affordance available |
| Last choice = in-memory | Stay in memory; unlock screen still accessible (passphrase / biometric input at login) |
| Last choice = file | Auto-open the last `.vmd` file, no passphrase prompt |
| Last choice = remote, session valid | Ask only for the passphrase (skip password) |
| Last choice = remote, session invalid | Ask for the account password first, then the passphrase |

### Changes

1. **Persist memory mode**
   - Call `rememberMode('memory')` in `unlockMemory()` (persistence.js) and `continueInMemory()` (app.js) so the choice survives reload.
   - Add an explicit `preferredMode === 'memory'` branch in `getAuthBootstrap()` returning `{ mode: 'memory', scenario: 'memory-remembered', ... }` so it never falls through to other heuristics.

2. **Force sign-out → demo page**
   - Change `submitSignOut()` / `handleSignOut()` and `persistence.signOut()` so the user lands on the in-memory demo (intro content) instead of the remote login screen.
   - Keep a clear "Sign in" action to return to the unlock flow.
   - Ensure the demo is flagged read-only (no persistence, clearly labeled "Demo — not saved").

3. **Remote staged unlock (two-step)**
   - Session **valid** → unlock screen shows only the passphrase (existing behavior, keep).
   - Session **invalid** → step 1: email + account password (authenticate); step 2: passphrase (decrypt). Implement as a staged `LockScreen` state (e.g. `authStep: 'password' → 'passphrase'`) rather than one combined form.

4. **Filesystem auto-open (verify)**
   - With `preferredMode === 'filesystem'` and a saved handle, boot should auto-open the file and bypass the lock screen entirely (mostly works via `filesystemStorage.tryReopen()` — verify and close any gap where the lock screen still flashes).

5. **Demo page on first visit**
   - Already returns `memory-fresh`; confirm intro renders as the read-only demo with a "Start writing" / "Sign in" choice.

### Files touched
- `source/js/persistence.js` — `unlockMemory`, `getAuthBootstrap`, `signOut`, `rememberMode`
- `source/js/app.js` — `continueInMemory`, `submitSignOut`, `LockScreen`, `submitUnlock`
- `source/js/ui.js` — Options modal sign-out handler if needed
- Tests: `tests/auth.spec.ts`, manual matrix above

---

## WS2 — Admin page

### Surface
A user-facing "Account / Admin" page reachable from the Options modal (and/or status toolbar), rendered as a hash route (`#/admin`). Separate from the existing debug panel.

### Sections (client-side, no backend — feasible now)

- **Account info** — email, username, member since, last sign-in, session validity, storage mode.
- **Security**
  - Change account password (Supabase `updateUser`).
  - Change email.
  - 2FA / MFA (TOTP) via Supabase client SDK — enroll, confirm, disable.
- **Passphrase (E2E-aware)**
  - **Change passphrase preserving data**: decrypt locally with old passphrase → re-encrypt with new → upload. (Upgrade over today's `resetRemoteData`, which discards data.)
  - **Recovery code**: issue/display a code at setup or on demand — the only way to regain access if the passphrase is forgotten (server can never reset it). Implemented as a locally-stored wrapped passphrase (per-device); cross-device recovery would need a server column.
  - **Reset remote data** (existing flow, kept as last resort).
- **Data**
  - Export plaintext `.vmd` backup (decrypt → download).
  - Import from backup.
  - Blob size, node count, last modified (client-computed).
- **Sessions & devices**
  - Sign out everywhere (needs a small Supabase Edge Function using service role — flagged as backend add-on).
  - Trusted-device list + remote revoke (pairs with WS3 biometric seal).
  - Lock now.
- **Payments (placeholder, deferred)** — plan tier, subscription status, renewal date, invoices, payment method, upgrade/downgrade/cancel. Requires Stripe + Supabase Edge Functions + webhooks + new tables. Marked speculative; no UI beyond a disabled placeholder until monetization is decided.

### E2E constraint
The passphrase can never be "reset" server-side. The admin page offers three honest paths: **change** (know current), **recovery code** (issued beforehand), **reset & lose data** (last resort).

### Files touched
- New: `source/js/admin.js` (page component + logic), route hookup in `source/js/ui.js` / `app.js`
- New CSS in `source/css/style.css`
- `source/js/persistence.js` — change-passphrase, export/import, recovery code helpers
- Backend (deferred): Edge Function for "sign out everywhere"; Stripe integration

---

## WS3 — Biometric / passkey unlock (Option B)

### Implemented mechanism (works in all WebAuthn browsers)
- The passphrase is sealed on this device: stored AES-GCM-encrypted with a **non-extractable key held only in IndexedDB** (its bytes never leave the crypto subsystem).
- Releasing it requires a **WebAuthn user-verification ceremony** (fingerprint / face / device PIN), which is hardware-backed on most systems.
- Unlock screen shows **"Unlock with biometrics"** when enrolled; admin page has **"Enable on this device"** / **"Forget this device"**.
- Nothing is sent to the server; the server still sees only ciphertext.

> Note: this uses the universally-supported **gate** pattern rather than the Chromium-only `prf` extension (which would seal the passphrase with an authenticator-derived secret). The gate pattern still gives per-device sealing + biometric release + hardware-backed verification, in Safari/Firefox too. PRF can be layered on later for Chromium.

### Files touched
- New: `source/js/biometrics.js` (WebAuthn register/get, non-extractable AES key, wrap/unwrap)
- `source/js/admin.js` — biometric enable/forget section
- `source/js/app.js` — `unlockWithBiometrics` + lock-screen button
- Tests: manual biometric flow (WebAuthn needs a real authenticator; not covered by Playwright e2e)

---

## Sequencing & verification

1. **WS1 first** (smallest, highest-impact UX fix, unblocks the others).
2. **WS2** (admin page builds on the auth/persistence plumbing).
3. **WS3** (largest; depends on stable unlock flow).

Per workstream: run existing unit tests (`crypto2Tests`, `metaTests`, etc. via `run-all-tests.mjs`) and Playwright e2e (`tests/auth.spec.ts`, `tests/sync.spec.ts`), then the manual scenario matrix above.
