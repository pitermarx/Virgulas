# Storage Interface — Design Document

Status: implemented (rollout through PR 3 shipped; §12 records the original plan).
Scope: persistence/sync internals, the documented data-06 and sync-01 behaviour
  fixes, and the TrailBase backend. TrailBase on the serving origin is the
  default; Supabase remains the static-deployment fallback.
Companion: `AGENTS.md` describes the shipped module map; §14 records the
  implementation deviations.

---

## 0. Summary

Virgulas currently has four persistence modes (Memory, Local, Remote, File) whose
logic is interleaved in `persistence.ts` and `sync.ts`, with Supabase-isms
(`user_id` in upserts, `PGRST116`) and crypto concerns (salt handling, envelope
format) leaking above the transport layer. This document specifies a layered
storage seam that separates:

- **what consumers care about** — the outline model (the store contract speaks
  `OutlineDoc`, not text),
- **how it is serialized** — a codec chosen per backend (JSON at rest, VMD for
  files), implemented in one place,
- **where and whether it is encrypted** — store internals (invisible above).

The refactor is behaviour-preserving with **two documented exceptions**, both
approved bug fixes at the seam: the stale-device silent-overwrite bug (sync-01
— an undecryptable remote now locks and prompts instead of being clobbered by
the next local push) and the silent localStorage quota failure (data-06 — a
failed local save now surfaces as `too-large`). See §4.4 and §11. Otherwise:
the existing four modes become thin adapters over the new contracts, the
existing test suite passes with **fixture-only** updates (§10), and new
backends (TrailBase, user-defined) become ~50-line compositions.

---

## 1. Goals and non-goals

### Goals

1. One `DocStore` contract that Local/Remote/File/Memory and future backends
   (TrailBase, user-defined) all satisfy.
2. Consumers never see ciphertext, envelope formats, salts, `user_id`, backend
   error codes, serialization, or serialized text.
3. Encryption is a property *inside* a store (decorator), not a concern of the
   orchestration. Non-encrypted stores stop being a special case.
4. Auth is a separate, complete contract (including account deletion and
   "confirmation required" as data, not comments).
5. Merge/conflict logic becomes a pure function over the outline model
   (three-way: local, remote, numeric baseline).
6. Backend adapters are trivially small and independently testable.
7. Backward compatibility: existing `vmd_data_enc` envelopes, Supabase rows, and
   `.vmd` files remain readable without migration.

### Non-goals

- Multi-document support (an optional `docId` is reserved in the design but not
  exposed — see Open Questions).
- Realtime/push sync (a `watch` capability slot is reserved; the 60s poll stays).
- Changing the on-disk/on-wire formats.
- Any change to crypto parameters (PBKDF2 600k, AES-GCM-256, envelope `v2`).
- Loading user-supplied JS adapter code at runtime (rejected — see §9.3).

---

## 2. As-is architecture (what moves and why)

```
app.ts ── persistence.ts ──┬─ outline.ts (model + VMD serialize/parse)
        │   (modes, unlock, │
        │    autosave, KDF  ├─ crypto2.ts (envelope, salt — called directly
        │    lifecycle,     │   by persistence flows)
        │    retry, merge   │
        │    triggers)      └─ sync.ts (Supabase client + auth + row CRUD
        │                        + scheduling + backoff + conflict signals)
```

Pain points, each of which the new seam removes:

| Pain | Where today |
| --- | --- |
| `user_id` supplied by the browser in `upsert` (Supabase RLS-ism) | `sync.ts remoteSync.upsert` |
| `PGRST116` error-code knowledge above the transport | `sync.ts withClient` |
| Salt stored differently per mode (row column vs `salt\|` prefix vs absent) | `persistence.ts` / schema |
| Envelope format knowledge (`v2:<iter>:`, KDF-upgrade-on-save) spread across flows | `persistence.ts` |
| "Email confirmation required" known only via a code comment | `sync.ts signUp` docstring |
| Account deletion was half-honest (auth record survives) on every backend | `persistence.ts deleteAccount` now branches on `deleteUser` |
| Merge entangled with Supabase read/write specifics | `sync.ts` / `persistence.ts` |

---

## 3. Target architecture

Three layers, each owning exactly one representation. Ciphertext and the node
tree never meet; serialized text exists only transiently inside codec calls.

```
┌──────────────────────────────────────────────────────────────┐
│ app.ts / ui / persistence orchestration                      │
│   representation: OutlineDoc (node tree)                     │
│   knows: capabilities, sync scheduling, lock-screen UX       │
├──────────────────────────────────────────────────────────────┤
│ storage.ts contracts — DocStore (public, speaks the model)   │
│   codecStore(codec, inner): serialization boundary           │
│     jsonCodec (Local/Remote at rest), vmdCodec (File)        │
│   encrypted(session): crypto boundary — string-level,        │
│     codec-blind; StringStore above, RawStore below           │
│   built-ins: memory, file; composed: local, remote           │
│   representation: OutlineDoc above, strings below the codec, │
│     opaque records below the crypto line                     │
├──────────────────────────────────────────────────────────────┤
│ RawStore (backend adapter contract — below both lines)       │
│   adapters: localStorage slot, supabase, (trailbase, …)      │
│   representation: opaque record { data, salt?, updatedAt? }  │
│   at rest: envelope around codec output (or plain bytes)     │
└──────────────────────────────────────────────────────────────┘
```

Identity: `AuthProvider` is a separate contract implemented only by
authenticated backends; it never touches documents.

Crypto rule (AGENTS Rule 7) is preserved structurally: all encryption lives in
`crypto2.ts` plus one decorator module that calls it. No adapter, no orchestration
code ever performs crypto.

---

## 4. Contracts

### 4.1 `DocStore` — the public, model-level contract

```ts
// source/js/storage.ts
export interface DocStore {
  /** The stored document, or null when the store holds nothing. */
  read(): Promise<OutlineDoc | null>

  /**
   * Upsert the document. Must refresh the change token.
   * Resolves with the new head token — the value a subsequent head() would
   * report — or null when the backend tracks no token. This lets the
   * orchestration refresh its last-seen token from the write itself: no extra
   * round-trip, and no mistaking the device's own push for a remote change.
   */
  write(doc: OutlineDoc): Promise<string | null>

  /** Delete the stored document ("purge my server/local data"). */
  clear(): Promise<void>

  /**
   * Cheap existence probe. MUST NOT require an unlocked session or a
   * passphrase (used by boot before the lock screen is shown).
   * For authenticated stores this may require a signed-in user.
   */
  exists(): Promise<boolean>

  /**
   * Opaque change token: MUST differ whenever the stored document changed,
   * MUST be stable when it did not. Consumers only compare for inequality;
   * they never interpret the value. Absent ⇒ no cheap change detection.
   */
  head?(): Promise<string | null>

  /** Encrypted stores additionally expose the lock lifecycle. unlock()
   *  resolves with what it decrypted (§4.3); decorators pass the result
   *  through unchanged. */
  unlock?(passphrase: string): Promise<UnlockResult | void>   // throws StoreError('wrong-key')
  lock?(): Promise<void>

  capabilities: StoreCapabilities
}

export interface StoreCapabilities {
  /**
   * Durability of the backend:
   * - 'always'  — survives reload/eviction by design (File, Remote)
   * - 'prompt'  — evictable unless the user grants persistence via
   *               navigator.storage.persist() (Local; the prompt flow hangs
   *               off this value and nowhere else — stores never call it)
   * - 'never'   — lost on reload (Memory)
   */
  durable: 'always' | 'prompt' | 'never'
  /** Data is encrypted at rest. Drives the lock screen. */
  encrypted: boolean
  /** Requires a signed-in user; pairs with an AuthProvider. */
  authenticated: boolean
  /** Cheap change detection available (head). */
  changeDetection: boolean
  /**
   * false ⇒ the backend cannot run in this browser (File mode without
   * showSaveFilePicker — Firefox/Safari). The backend is never constructed;
   * mode selection (§6.1) and the options UI filter on this. Construction
   * itself never throws for environment reasons — this flag replaces the
   * scattered feature detection in today's UI code.
   */
  available: boolean
}
```

Capability placement rules: `passwordReset`/`oauth` stay on
`AuthProvider.capabilities` (§4.5) — they are auth concerns, not store
concerns; `deleteUser` is capability-by-presence on the `AuthProvider`
(optional method, §4.5). `watch` is an optional *method* on `RawStore` (§4.2),
not a boolean here; its presence is the capability, absence-tested like
`head?()`.

**Invariants**

- `read()` returns null for "empty", never throws for it. Codec parse/validate
  failures throw `invalid-document` (§4.6); all other failures throw typed
  `StoreError`s (§4.4).
- `write()` is upsert semantics; adapters must not require read-before-write.
  When `head()` exists, the token `write()` resolves with equals the token a
  subsequent `head()` reports for the same write.
- The contract speaks the outline model; serialized text never crosses it.
  Each store composes a codec (§4.6) below the seam.
- `exists()` and `head()` never decrypt, never parse VMD, and never run the KDF.
- `unlock()` performs the one-and-only passphrase verification per session:
  derive (cached by salt), attempt decryption of the at-rest payload, throw
  `WrongKeyError` on AES-GCM authentication failure. There is deliberately no
  separate "verify passphrase" primitive — decryption is the verifier, exactly
  as today.

### 4.2 `RawStore` — the backend adapter contract (below the crypto line)

Backend adapters (localStorage, Supabase, TrailBase, user-defined) implement
this. They store opaque records; they never see plaintext documents and never
see the outline model. There is no user-facing backend choice: the server is
TrailBase on the origin serving the app (`trail run --public-dir dist`),
resolved automatically in the remote flows (override slot → same-origin probe
→ legacy Supabase read-through → hosted Supabase fallback).

```ts
// source/js/storage.ts
export interface RawRecord {
  /** Opaque payload: ciphertext envelope for encrypted backends, plain VMD otherwise. */
  data: string
  /** Opaque auxiliary field the encrypted decorator uses (the salt). */
  salt?: string
  /** Modification stamp assigned by the adapter (Supabase today: client-side
   *  through the adapter — documented limitation, §5). */
  updatedAt?: string
}

export interface RawStore {
  readRaw(): Promise<RawRecord | null>          // null = no record
  // upsert; the adapter assigns updatedAt (Supabase: client clock — §5
  // limitation). Resolves with the new head token (the value head() would now
  // report), or null if untracked.
  writeRaw(record: RawRecord): Promise<string | null>
  clearRaw(): Promise<void>
  exists(): Promise<boolean>                     // no key/session required
  head?(): Promise<string | null>
  /** Push-based change notification (PR 4, SSE-capable backends). Emits the
   *  new head token on remote change; the returned function unsubscribes.
   *  Absent ⇒ polling only. */
  watch?(emit: (token: string) => void): () => void
}
```

The **identity binding rule**: orchestration never sees or supplies a user id
(Goal 2); binding the record to the signed-in user is the adapter's job. How
it binds is backend-specific: TrailBase `_REQ_.user` ACL and PocketBase API
rules keep the id off the wire entirely. Supabase's schema makes `user_id`
the primary key with **no default**, so under the zero-migration promise the
adapter must still send it — but sourced from the **locally cached session**
(`auth.getSession()`, no network round-trip; today's code runs
`auth.getUser()` on every push), and RLS `with check (auth.uid() = user_id)`
server-verifies that the value equals the JWT's, so it cannot be forged.
Removing it from the wire entirely (`default auth.uid()`) needs a migration
and rides with the deferred follow-up (§12).

### 4.3 `encrypted()` — the crypto decorator

```ts
// source/js/encryptedStore.ts  (the only module besides crypto2.ts and
// biometrics.ts that touches key material — Rule 7)

export function encrypted(raw: RawStore, session: KeySession): StringStore
// capabilities: inherits durable/available/authenticated/changeDetection from
// the inner raw store; sets encrypted: true

/**
 * String-level mirror of DocStore: identical lifecycle, string payloads.
 * Returned by encrypted() and by plain string stores; codecStore() (§4.6)
 * lifts a StringStore into a DocStore. The crypto decorator sits BELOW the
 * codec and only ever sees strings — it knows no document format.
 */
export interface StringStore {
  read(): Promise<string | null>
  write(doc: string): Promise<string | null>   // new head token, or null
  clear(): Promise<void>
  exists(): Promise<boolean)
  head?(): Promise<string | null>
  unlock?(passphrase: string): Promise<UnlockResult | void>   // throws StoreError('wrong-key')
  lock?(): Promise<void>
  capabilities: StoreCapabilities
}
```

Responsibilities (all currently scattered in persistence flows, now in one place):

1. **Serialize at rest** — emits the existing envelope `v2:<iterations>:<base64(iv‖ct)>`
   and carries the salt in `RawRecord.salt`. The inner adapter decides where the
   salt physically lives (localStorage slot prefix, DB column, or inline) — from
   above, it is opaque either way.
2. **KDF lifecycle and salt policy** — `KeySession` caches derived `CryptoKey`s
   so autosave never re-runs the 600k PBKDF2. Local and Remote share one session
   (one passphrase, one key cache). Their salts are *usually* equal but **can
   diverge**: a passphrase rotated on another device puts a foreign salt in the
   remote row. Rotation always changes salt and passphrase together, so a record
   whose salt differs from the session's `activeSalt` can never decrypt under the
   retained passphrase — the decorator raises a typed `remote-rekeyed` error
   (§4.4) *without* burning a derivation, instead of failing silently and
   letting the next push overwrite the rotated remote (fixes sync-01). The cache
   holds 2–4 entries keyed by (salt, iterations), so alternating salts cost one
   derivation each, not one per operation (fixes sync-10).
3. **Legacy envelopes** — raw base64 payloads decrypt at 310,000 iterations
   (unchanged); any successful save re-encrypts at current parameters (600k),
   preserving today's upgrade-on-save behaviour.
4. **WrongKeyError** — GCM auth failure during `unlock()` maps to the typed error
   the lock screen already handles.
5. **Biometrics** — `biometrics.ts` seals/unseals the *passphrase*; the unsealed
   passphrase feeds `unlock()` exactly as typed input does. No change.
6. **Secret retention** — the session passphrase lives **only** inside
   `KeySession` (memory-only; derived keys are non-extractable; everything is
   dropped on `lock()`). This replaces today's three retention sites:
   `sync.ts _passphrase`, the `persistence.ts` passphrase signal, and the
   `deferredPushPayload` copy. Orchestration holds no secrets (Goal 2).

`KeySession` is internal to the crypto layer:

```ts
export interface KeySession {
  /** The salt writes encrypt under this session. Set by a successful
   *  unlock-decrypt, first-time setup, or rotation; null while locked. */
  readonly activeSalt: string | null

  /** Derive (or return cached) key for (salt, passphrase). Small multi-entry
   *  cache keyed by (salt, iterations). Callers map GCM auth failure to
   *  WrongKeyError. */
  keyFor(salt: string, passphrase: string): Promise<CryptoKey>

  /** Rotation: generate a fresh salt, derive a fresh key from newPassphrase,
   *  and make both active. Subsequent writes re-encrypt everything (§6.7). */
  rotate(newPassphrase: string): Promise<void>

  /** Drop the passphrase and every cached key (lock, sign-out, teardown). */
  lock(): void
}
```

### 4.4 Error taxonomy

```ts
export class StoreError extends Error {
  code: 'wrong-key' | 'remote-rekeyed' | 'unauthenticated' | 'network'
      | 'not-found' | 'invalid-input' | 'too-large' | 'invalid-document'
      | 'corrupt-data' | 'unsupported-runtime' | 'unsupported'
  cause?: unknown   // the original typed error, preserved for UI branching
}
```

Errors are **two-channel**: orchestration switches on `code` (retry vs lock vs
surface), UI switches on `cause` when it needs the specific message or the
reset offer. `encrypted()` always attaches the original `crypto2` typed error
as `cause`, so the lock screen's existing `instanceof` branches keep working —
this is what makes the mapping behaviour-preserving.

Adapter mapping: Supabase `PGRST116` → `not-found` (surfaced as `read() → null`);
401s → `unauthenticated`; transport failures → `network` (retryable — the
orchestration's backoff keys off this); the 16 MiB size check → `too-large`
(adapters enforce their own bounds, mirroring today's SQL constraints); a
localStorage quota failure in the local slot → `too-large` as well, surfaced
instead of swallowed (fixes data-06).
TrailBase: 401/403 → `unauthenticated`, 404 → `not-found`, every other 4xx
except 408/429 → `invalid-input` (a malformed email, password-policy rejection,
conflicting write — retrying the same request cannot succeed), while 408/429
and 5xx/transport failures → `network` (retryable).
Codec parse failures after a successful decrypt → `invalid-document` (raised by
the codec, §4.6). A pulled record whose salt differs from the session's
`activeSalt` → `remote-rekeyed`: another device rotated the passphrase. It is
never swallowed and never followed by a push — the orchestration locks the
session and prompts for the new passphrase (fixes sync-01). GCM failure during
`unlock()` remains `wrong-key`.

Crypto-layer mapping in `encrypted()`:

| `crypto2` failure | `code` | Notes |
| --- | --- | --- |
| `WrongPassphraseError` (GCM auth) | `wrong-key` | unchanged |
| `CorruptEnvelopeError` (bad separator/base64/gzip) | `corrupt-data` | **not** `wrong-key` — no passphrase is wrong |
| iteration-bounds violation (sec-04, hostile envelope) | `corrupt-data` | guard stays in `crypto2` |
| `UnsupportedVersionError` (future envelope) | `unsupported-runtime` | UI: "reload the app" |
| `UnsupportedBrowserError` (no DecompressionStream) | `unsupported-runtime` | UI: "update your browser" |

`unsupported-runtime` is deliberately distinct from `unsupported`, which stays
"this backend can't do this operation" — reserved for genuine operation gaps;
no planned adapter currently raises it (account deletion is **not** modelled
this way — it is `auth.deleteUser?()` absence, §4.5).
The destructive-reset offer (`canResetRemoteData`) triggers on
`code === 'wrong-key'` **only** — not on `corrupt-data` (no passphrase is
wrong) and not on `remote-rekeyed` (resetting would clobber the rotated
remote; prompt for the new passphrase instead). That tightening is part of
declared exception 1 (§0/§11), same bug class as sync-01.

### 4.5 `AuthProvider` — complete auth contract

```ts
// source/js/storage.ts
export interface AuthUser {
  id: string
  email?: string
  emailVerified?: boolean
}

export interface SignUpResult {
  user: AuthUser
  /** false ⇒ "confirmation required, not signed in yet" — data, not a comment. */
  session: boolean
}

export interface AuthProvider {
  signUp(email: string, password: string): Promise<SignUpResult>
  signIn(email: string, password: string): Promise<AuthUser>
  signOut(): Promise<void>
  getUser(): Promise<AuthUser | null>

  updatePassword(newPassword: string): Promise<void>
  updateEmail(newEmail: string): Promise<void>

  /**
   * Self-service auth-account deletion — optional; presence is the
   * capability. Supabase adapter: **absent** (deleting `auth.users` needs the
   * service role, which the browser never holds). No password/re-auth
   * parameter: re-verification is a product decision requiring a SPEC change
   * (Open Question 7), not something to invent here.
   */
  deleteUser?(): Promise<void>

  requestPasswordReset?(email: string): Promise<void>   // capability-gated

  capabilities: {
    passwordReset: boolean
    oauth: boolean
  }
}
```

- Session/token persistence across reloads is provider-internal. If a provider
  persists tokens in `localStorage`, it must go through a `store` slot in
  `utils.ts` (Rule 7).
- `getUser()` is the **server-verified** probe (a network round-trip on
  Supabase): boot and session checks use it; the write path must not. The
  Supabase adapter sources its uid from the cached session (§4.2).
- The product's **Delete account** flow is an orchestration sequence mirroring
  today's `persistence.deleteAccount()` step-for-step:
  1. require a signed-in user (typed `unauthenticated` error otherwise),
  2. **quiesce**: stop polling, clear the deferred-push queue and pending
     saves, clear credentials — so an in-flight upload cannot resurrect the
     deleted row,
  3. `store.clear()` — on an authenticated store this deletes the RLS-scoped
     row. It **must succeed before the device wipe**; if it throws, the flow
     aborts with local data intact (retryable),
  4. `auth.deleteUser?.()` when present — TrailBase deletes the auth record;
     the Supabase adapter omits it, so its `auth.users` row survives,
  5. device wipe (every slot, biometric seal, offline shell caches),
  6. `auth.signOut()`.
  UI messaging branches on `deleteUser` presence: TrailBase says the account
  is deleted, Supabase says the auth record is kept.

### 4.6 Codecs and merge — library modules, not a layer

```ts
// source/js/docCodec.ts
export interface DocCodec {
  serialize(doc: OutlineDoc): string
  parse(text: string): OutlineDoc   // validates; throws StoreError('invalid-document')
}

export const jsonCodec: DocCodec   // JSON at-rest format (outline.serialize/deserialize)
export const vmdCodec: DocCodec    // the single VMD parser/writer, shared with outline.ts —
                                   // File mode, export/import, intro.vmd

/** Lifts a StringStore into a DocStore: read → parse, write → serialize. */
export function codecStore(codec: DocCodec, inner: StringStore): DocStore
```

```ts
// source/js/merge.ts — pure function, no store I/O
export function merge(local: OutlineDoc, remote: OutlineDoc, baseline: number): MergeResult

// MergeResult = { kind: 'merged'; doc: OutlineDoc }
//             | { kind: 'conflict'; conflicts: NodeConflict[]; partial: OutlineDoc }
```

- Backends **choose** a codec; they never write one. Serialization is owned by
  exactly these two implementations, and the VMD parser/writer is shared:
  `outline.getVMD()` / `outline.setRootVMD()` delegate to `docCodec.ts` (the
  per-node `outline.setVMD` keeps its own backtick-escape editor path). All
  future format versioning and migrations live in `docCodec.ts` and nowhere
  else.
- Zero at-rest migration: Local/Remote keep JSON-in-envelope (the codec choice
  sits below the crypto line, so envelope bytes are unchanged); File keeps
  plain VMD.
- Composition order keeps the crypto decorator codec-blind (§9.5): e.g.
  `codecStore(jsonCodec, encrypted(slotRaw('vmd_data_enc'), session))`.
- `codecStore()` returns `unlock()`'s `UnlockResult` unchanged (as does
  `cached()`); orchestration calls the outermost store and never needs a
  string-level handle on the inner primary.
- `merge` is a pure three-way function over two models and a numeric baseline
  (epoch ms): per-node `lastModified` vs baseline distinguishes changed /
  unchanged / deleted; same-field edits conflict. Extracted from the current
  `sync.ts mergeDocuments`; the blocking conflict modal flow is unchanged.
  The baseline is orchestration-owned sync state, **not** a store property,
  and must not be conflated with the opaque `head()` token — two clocks, two
  slots (§8, resolved).
- Memory mode round-trips the intro tour through `jsonCodec` (validation for
  free); the live outline itself is the Memory store (§14.12). VMD is no longer
  involved outside File/export.

### 4.7 `cached()` — the offline-cache decorator

```ts
// source/js/cachedStore.ts
export interface CachedOptions {
  /** null on success, the error on failure. When present the caller owns the
   * local-failure surface and a cache error no longer fails the write. */
  onCacheWrite?(error: unknown | null): void
}
export function cached(primary: StringStore, cache: StringStore, options?: CachedOptions): StringStore
```

Remote mode is really two stores: the backend (source of truth) and the local
cache slot (`vmd_data_enc`), which is what makes offline mid-session operation
(the write tee, cached reads after connectivity loss) and a correct lock
screen on offline boot (the `exists()` union) work. It does **not** make
offline *unlock* work — see the `unlock` row. The orchestration builds the
pairing once (`buildRemoteStore`); `cached()` makes it a composition, and the
caller holds only the composed store. Both sides share the one `KeySession`
(§4.3), so the two copies always carry the same salt and envelope.

| Op | Rule | Rationale |
| --- | --- | --- |
| `write(doc)` | cache first, then primary; resolve with the primary's token | matches today's local-save-then-remote-push order |
| primary fails `network` | cache write **stands**; the error propagates | deferral/retry belongs to the orchestration (§6.4); stores do single operations |
| cache fails (quota) | primary is still attempted; with `onCacheWrite` the failure is reported there and the write resolves with the primary token, without it `too-large` propagates | the save is durable remotely but not locally; Remote's hook drives the toolbar's "not saved locally" state (fixes data-06) |
| `read()` | primary; on `network` error fall back to cache | mid-session connectivity-loss reads (an already-unlocked session; offline *boot* stops at the primary-only `unlock` row below). The fallback may be stale — a merge against a stale self-copy is a no-op merge |
| `exists()` | `cache ∥ primary` | offline boot must still show the lock screen |
| `head()` | primary only; errors → orchestration treats as "no change" | change detection is about the source of truth (today's `checkRemoteNewer` catch) |
| `unlock(pw)` | **primary only**; resolves with the primary's `UnlockResult`; a `network` error fails the unlock exactly as today — no cache fallback. A foreign-salt primary → `remote-rekeyed` (§4.3) | behaviour-preserving: today's `unlockRemote` verifies against the **remote** record, and an offline Remote reload needs connectivity. The passthrough means the caller never holds the inner string store. Offline unlock via the cache is a future capability (OQ 8), not a decorator side effect |
| `clear()` | clear both | purge means purge everywhere |

With `write()` taking an `OutlineDoc`, the orchestration's deferred-push queue
holds **documents, not ciphertext**: `deferredPushPayload`'s
`{ encrypted, salt, passphrase }` triple disappears, and a flush is just a
re-run of `store.write(doc)` (Goal 2 becomes literally true).

---

## 5. Backend matrix (existing four modes + future)

| Mode | Composition | At-rest shape | Change token (`head`) |
| --- | --- | --- | --- |
| Memory | live outline (no store instance; §14.12) | RAM only | n/a |
| File | `codecStore(vmdCodec, fileStore(handle))` | plain `.vmd` bytes | `file.lastModified` |
| Local | `codecStore(jsonCodec, encrypted(slotRaw('vmd_data_enc'), session))` | `salt\|v2:600000:…` in slot | content hash of slot |
| Remote (Supabase) | `codecStore(jsonCodec, cached(encrypted(supabaseRaw(client), session), encrypted(slotRaw('vmd_data_enc'), session)))` + Supabase `AuthProvider` | `outlines` row (`salt`, `data`, `updated_at`) — **unchanged schema**; local cache slot | `updated_at` |
| Remote (TrailBase — the default) | `codecStore(jsonCodec, cached(encrypted(trailbaseRaw(config), session), encrypted(slotRaw('vmd_data_enc'), session)))` + TrailBase `AuthProvider` | `outlines` STRICT table row (uuid owner column referencing `_user(id)`); local cache slot | `updated_at` |
| User-defined (future) | any `RawStore` from the built-in registry | adapter-defined | adapter-defined |

Notes:

- Local's `head` as a content hash is cheap enough (the poll only runs in Remote
  mode; Local has a single writer) and satisfies the token invariants exactly.
- **Token scope**: the poll loop consumes only the Remote head, and the
  `vmd_sync_head` slot (§8) is written by Remote orchestration alone.
  Memory/File/Local tokens are session-scoped conveniences, never persisted
  across reloads (Memory's counter resets with the document it tracks — both
  die on reload, so there is nothing to detect). The contract suite's head
  cases run for every adapter exposing `head` and assert the per-session
  differ/stable invariants (§4.1).
- The Supabase adapter keeps the existing row shape and RLS policies verbatim —
  zero schema migration for existing users. The `user_id` column is still
  populated, but by the adapter from the locally cached session — never
  supplied by orchestration, and no `auth.getUser()` round-trip per push
  (§4.2, today's cost).
- **`updated_at` is client-supplied today** (unchanged schema): the adapter
  stamps `new Date().toISOString()`, so the Supabase `head()` token inherits
  client-clock trust — not monotone across devices, forgeable by a compromised
  client, and the substrate of sec-12 (no anti-rollback) and sync-04 (no
  compare-and-swap). This is pre-existing, not introduced by the refactor; the
  seam isolates it inside `supabaseBackend`. Documented limitation — the fix
  (server-managed stamp via trigger + column privilege revoke, adapter returns
  the server token from `write()`) is deferred and revisited with the
  sync/data findings follow-up work (§12, §13 OQ 6). The TrailBase adapter
  (PR 3) shares the same limitation today — it also accepts a client-supplied
  `updated_at` — so the follow-up makes the two backends consistent.
- `docId` is deliberately absent from the contracts. If multi-document support
  is ever wanted, it is added as an optional parameter defaulting to a constant;
  retrofitting later touches only adapters. Deciding now is an Open Question.

---

## 6. Behavioural flows (before → after)

### 6.1 Boot / mode selection (`persistence.getAuthBootstrap`)

Unchanged decision logic (remembered mode + existing-data signals), now
expressed as: pick a backend from config → construct its `DocStore` (+`AuthProvider`
if authenticated). The startup-path rule is preserved:

- File handle lookup gated on `filesystem` mode.
- Session probe (network) gated on `remote` mode.
- Backends with `capabilities.available === false` are filtered out before
  construction (File on Firefox/Safari): a remembered-but-unavailable mode
  falls back exactly as an unusable remembered mode does today — no
  environment errors are ever thrown from constructors.
- The `navigator.storage.persist()` prompt (Safari ITP eviction protection)
  hangs off `capabilities.durable === 'prompt'` and stays an orchestration/
  options-panel concern; stores never call it themselves.

### 6.2 Unlock (Local/Remote)

```
lock screen shown  ⇐ store.capabilities.encrypted && store.exists()
passphrase entered → store.unlock(passphrase)
                      └─ decorator: read salt from at-rest → session.keyFor(salt, pw)
                         → attempt decrypt → WrongKeyError? reject
                         : unlocked — salt becomes session.activeSalt, key cached,
                           passphrase retained inside KeySession only (§4.3)
document rendered  ⇐ store.read()          // codec parses + validates below the seam
```

First visit (no data): passphrase *setup* wraps the first `write` — the decorator
generates the salt once and reuses it (today's behaviour).

### 6.3 Autosave

```
edit → debounce → activeStore.write(doc)   // codec+crypto below; + remote scheduling in Remote mode
```

The derived key comes from the session cache — no KDF per save. A legacy 310k
envelope is transparently re-encrypted at 600k on this write. In Remote mode
the write goes through `cached()` (§4.7): the cache write is the durable local
save; a primary `network` failure propagates to the orchestration, which
defers and retries (§6.4). A cache quota failure is reported through the
composition's `onCacheWrite` hook: the remote save completes and the status
toolbar reports the document as not saved locally until the next successful
cache write (data-06).

### 6.4 Remote poll / pull-before-push (Remote mode)

```
every 60s:  token = remoteStore.head()
            token ≠ lastSeen → doc = remoteStore.read()
                                → merge(localDoc, doc, baseline)      // pure (§4.6)
                                → merged: write local + remote stores
                                          lastSeen := token returned by write()
                                → conflict: blocking modal (unchanged UX)
            lastSeen updated from every successful write's returned token
```

- `head()` compares an opaque token for change detection only. The numeric
  merge `baseline` (epoch ms, today's `vmd_sync_ts` semantics) is a second,
  orchestration-owned clock and stays numeric — two clocks, two slots (§8,
  resolved).
- `write()` returning the new head token is what prevents the self-push
  ping-pong: the poller adopts the token its own write produced, so it never
  re-pulls its own update. It replaces today's
  `beginRemotePush`/`recordCompletedRemotePush`/`isSupersededOwnRemoteUpdate`
  client-timestamp bookkeeping.
- Scheduling, queueing, `remoteSyncNotBefore` backoff, `retryWithBackoff`,
  `skipNextRemotePush` all stay in the orchestration, keyed off the typed
  `network`/`unauthenticated` errors. Stores do single operations only.
  `remoteSave.ts` owns the save-side half: the injected store, the
  pull-before-push cycle, the retry policy and the deferred queue;
  `persistence.ts` keeps the debounce and session lifecycle.
- The deferred-push queue holds **documents** (`{ doc, attempt }`), never
  ciphertext/salt/passphrase — a flush re-runs `store.write(doc)`, and the
  epoch-staleness guard (today's `isRemoteSyncAttemptStale`) makes the flush
  write the latest document rather than a stale snapshot.
- The poll defers to active local edits — unchanged.

### 6.5 Account deletion, purge, export/import

- **Purge**: `store.clear()` (+ for Local: drop the slot; encrypted state drops
  with it).
- **Account deletion**: the §4.5 orchestration sequence (quiesce → `clear()` →
  optional `deleteUser` → wipe → `signOut()`), with the failure-before-wipe
  ordering preserved; honest messaging via `auth.deleteUser?()` presence.
- **Export/import**: operate on VMD text / `.vmd` files exactly as today; they
  use `vmdCodec` directly — a store is not involved.

### 6.6 Quick capture

Unchanged. The inbox queue is local metadata (store slot), reconciled into the
document by the model layer; never touches the store seam. The boot rule stands:
no store is constructed, no network, no KDF until the user confirms.

### 6.7 Passphrase rotation

```
user confirms rotation → doc = store.read()
                       → session.rotate(newPassphrase)   // fresh salt + fresh key,
                                                         // becomes activeSalt
                       → store.write(doc)                // re-encrypts everything
                                                         // under the new key
```

Mirrors today's `changePassphrase` (new salt, re-encrypt, push, cache) with the
secrets never transiting orchestration. A stale device holding the old
passphrase meets `remote-rekeyed` on its next pull (§4.4) and locks with a
prompt instead of silently reverting the rotation (sync-01 fix).

---

## 7. Module plan (all inside `source/js/`, Rule 5)

| Module | Responsibility | Origin |
| --- | --- | --- |
| `storage.ts` (new) | Contracts: `DocStore`, `StringStore`, `RawStore`, `AuthProvider`, capabilities, `StoreError`, backend registry/factory. **Not** the `store` slots in `utils.ts` — Rule 7's vocabulary is unchanged; the new abstraction owns the capitalized `*Store` filenames (`encryptedStore.ts`, `cachedStore.ts`, `memoryStore.ts`, …), `utils.store` remains the localStorage-slot facade | extracted from `sync.ts` + new |
| `encryptedStore.ts` (new) | `encrypted()` decorator (string-level, codec-blind), `KeySession` (via `crypto2.ts`) | from `persistence.ts`/`sync.ts` envelope logic |
| `cachedStore.ts` (new) | `cached()` decorator: write order, offline read fallback, exists-union, quota propagation | from `persistence.ts` local-cache branches |
| `docCodec.ts` (new) | `DocCodec` contract, `jsonCodec`, `vmdCodec`, `codecStore` lift, parse/validate errors; owns the VMD parser/writer that `outline.ts` delegates to | codecs are the serialization source of truth |
| `merge.ts` (new) | pure three-way merge over the model (baseline-aware) | from `sync.ts mergeDocuments` |
| `memoryStore.ts`, `fileStore.ts`, `localStore.ts` (new, tiny) | built-in string-level adapters | from `persistence.ts` mode branches |
| `supabaseBackend.ts` (new) | `RawStore` + `AuthProvider` over `@supabase/supabase-js` (dynamic import preserved) | from `sync.ts` |
| `sync.ts` (shrinks) | scheduling, poll, backoff, status/conflict signals — no client code | remainder of current `sync.ts` |
| `persistence.ts` (shrinks) | pure orchestration: boot, unlock UX wiring, autosave debounce, mode switching, store construction | remainder of current |
| `remoteSave.ts` (new) | Remote save orchestration: injected store, pull-before-push, retry policy, deferred-push queue | `persistence.ts` `doSave` + deferred queue |
| `crypto2.ts`, `outline.ts`, `biometrics.ts`, `utils.ts` | unchanged | — |

Circular-dependency rule: adapters import `storage.ts` (contracts only); nothing
below imports anything above. `persistence.ts`, `remoteSave.ts` and `sync.ts`
sit at the top and are the only consumers of `merge` + `DocStore` together.

Module size rule: each new module is well under the 350–450 line split threshold.

---

## 8. Config and data migration

- **No at-rest data migration.** Existing envelopes (legacy and `v2`), Supabase
  rows, and `.vmd` files are read as-is by the corresponding adapters.
- `localStorage.supabaseconfig` is generalized to `backendconfig`
  (`{ backend: 'supabase' | 'trailbase' | …, url, key }`) with a one-time
  read-through of the old key in the `store` slot initialization, so existing
  browsers keep working. The hosted default seeds as today. Specs that write
  the old slot directly are updated mechanically (§10).
- Two clocks coexist and stay in separate slots (resolved): the numeric merge
  baseline (epoch ms — today's `vmd_sync_ts` semantics, unchanged) and the
  opaque `head()` change token (a new `vmd_sync_head` slot). Token values are
  never parsed as timestamps; baseline values never leave the orchestration.
- All slot access stays behind `store` in `utils.ts` (Rule 7). Naming note:
  the new contracts module is `storage.ts` — deliberately **not** `store.ts`,
  so Rule 7's "`store` slots in `utils.ts`" vocabulary stays unambiguous.

---

## 9. Security analysis

1. **Crypto containment (Rule 7).** Key material exists only in `crypto2.ts`,
   `encryptedStore.ts` (which calls `crypto2`), and `biometrics.ts` (device-local
   passphrase seal — unchanged exception). `KeySession` is the single in-memory
   retention point for the session passphrase (§4.3); adapters and orchestration
   handle opaque strings only and hold no secrets.
2. **Identity binding.** Orchestration never asserts `user_id`; the backend
   enforces owner-only access (RLS today — which *rejects* any client-stamped
   uid that doesn't match the JWT — TrailBase ACL `_ROW_.user = _USER_.id`
   tomorrow). The Supabase adapter sources the uid from the cached session,
   not a per-push `getUser()` round-trip (§4.2). Defense-in-depth grants from
   `outlines.sql` carry over verbatim.
3. **Test seams.** The `__TEST_HOOKS__` window-supabase seam becomes a gated
   window hook that injects a `RawStore`/`AuthProvider` *factory* for specs.
   Production builds still compile it out; `tests/e2e/e2e-seam.spec.ts` continues to
   assert both builds behave. The e2e `e2e` binding stays as is.
4. **User-defined backends — policy.** Supported tiers: (a) config-driven
   presets pointing built-in adapters at user-chosen instances (same trust model
   as today's `supabaseconfig`), (b) additional built-in protocol adapters
   (WebDAV/S3 class). **Arbitrary user-supplied JS adapters at runtime are
   rejected**: a malicious adapter receives every decrypted document by design,
   and the CSP (`script-src 'self'` + SRI-pinned tracker) exists precisely to
   keep foreign code out. This restriction is documented, not worked around.
5. **Plaintext lifetime.** Serialized text (JSON or VMD) exists only
   transiently inside codec calls and inside stores; the app itself handles
   only the model — strictly narrower exposure than today.
6. **Head-token trust.** For Supabase today, `head()`/`write()` tokens are
   client-stamped `updated_at` values (§5 limitation). What the token
   guarantees: changed-vs-unchanged detection between honest clients. What it
   does **not**: anti-rollback (sec-12) or compare-and-swap (sync-04) — a
   compromised client or stolen session can stamp arbitrary tokens, exactly as
   today. The refactor neither improves nor worsens this; it confines the
   weakness to one adapter and gives the follow-up fix a single touch point
   (swap the stamp source inside `supabaseBackend`, return the server value
   from `writeRaw`).

---

## 10. Testing plan (Rule 3)

**Unit suites** (`tests/unit/suites/`, registered in `unit.test.ts`):

- `storeContractTests.ts` — the contract conformance suite: run every adapter
  (memory, file (fake handle), local slot, encrypted-over-fake-raw, cached
  pairs) against the same behavioural spec (upsert semantics,
  exists-without-key, head invariants, typed errors). `cached()` cases: write
  order (cache before primary), primary `network` failure leaves the cache
  write standing and propagates, read falls back to cache only on `network`,
  exists-union, head is primary-only, cache quota failure surfaces
  `too-large` after the primary attempt. Crypto-failure cases assert **both
  channels**: `code` (`wrong-key` / `corrupt-data` / `unsupported-runtime`) and
  the original `crypto2` error preserved in `cause`. Capability-descriptor
  cases: memory `durable: 'never'`, file `durable: 'always'` with `available`
  tracking `showSaveFilePicker` presence, local `durable: 'prompt'`, remote
  `durable: 'always'`; `encrypted()` inherits the inner descriptor and sets
  `encrypted: true`. This is the piece that makes future
  backends cheap to trust.
- `encryptedStoreTests.ts` — envelope round-trip, salt reuse, legacy 310k
  decrypt + upgrade-on-save, WrongKey mapping, key-cache (one KDF per session;
  uses `__TEST_KDF_SCALE__`), multi-entry cache (alternating salts derive once
  each — sync-10), `remote-rekeyed` on a foreign-salt pull with **no** upsert
  afterwards (sync-01 regression: mock remote returning ciphertext under a
  different salt; assert no write, error state, locked session), rotation flow
  (§6.7).
- `docCodecTests.ts` — json/vmd serialize/parse round-trip, invalid-document
  error, `codecStore` lift behaviour (read→parse, write→serialize, token
  passthrough).
- `mergeTests.ts` — auto-merge same-node different-field, conflict same-field,
  baseline semantics (deleted-vs-unchanged via per-node `lastModified`),
  pureness (no store calls inside merge).
- `supabaseBackendTests.ts` — adapter mapping (PGRST116 → not-found, etc.)
  with a fake client; auth adapter: `deleteUser` **absent** (not throwing),
  `clear()` issues the RLS-scoped row DELETE; `upsert` sources the uid from
  the cached session — assert the fake client's `auth.getUser` is never
  called on the write path.

**Playwright** — all existing specs must pass with **fixture-only updates**;
behavioural assertions stay untouched, and any failure beyond the enumerated
mechanics is a behaviour regression, not a fixture problem. The complete list
of permitted spec deltas in PR 2d:

1. Slot rename `supabaseconfig` → `backendconfig` in the `tests/test.ts`
   init-script fixture and in the specs that write it directly (`admin`,
   `auth`, `sync`, `sync-polling-merge`, `synctrigger`). Value shape is
   backwards-compatible (`backend` defaults to `'supabase'`).
2. `offline.spec.ts` residual-key list gains `vmd_sync_head` (§8's second
   clock) — one line, mechanical.
3. Seam setup in the admin/auth/sync/sync-polling-merge/synctrigger specs
   moves to the new `RawStore`/`AuthProvider` factory hook (§9.3).
4. `sync.spec.ts`'s mid-test config switch (~line 716) writes the new slot;
   its URL value is decorative — the `window.supabase` seam supplies the
   client — but with the one-time read-through the write must target
   `backendconfig` (or move into the init script) to stay coherent. This is
   the one fixture adjustment that needs thought rather than search-replace.

New spec: unlock + autosave + poll flows against a fake remote via the seam
(the contract-level equivalent of sync-polling-merge).

**Definition of done**, per PR (§12): every PR — `bun run typecheck`,
`bun run test:unit` green, README/AGENTS wording updated where module maps or
contributor guidance moved. PRs 1/2a/2b — e2e untouched and green by
construction (new code is unimported). PRs 2c/2d — `bun run test:e2e` green
(2d after §10's fixture-only updates), no behaviour diff beyond that PR's
declared exception, and the SPEC wording change in the same commit (Rule 1).

---

## 11. SPEC and docs impact

Behaviour is unchanged with two deliberate exceptions (approved bug fixes):

1. An undecryptable remote is no longer silently overwritten by the next local
   push — the stale device locks and prompts (`remote-rekeyed`, sync-01).
   The destructive-reset offer tightens to `wrong-key` only (§4.4) — same bug
   class. `SPEC.vmd`'s pull-before-push section says a newer remote is
   "fetched and merged silently"; the PR must add the stale-device branch to
   that SPEC wording in the same commit (Rule 1).
2. A localStorage quota failure during a local/cache save is no longer silent
   — it surfaces as `too-large` with an actionable error state (data-06). The
   SPEC's autosave/save section needs the error-state wording in the same
   commit.

Otherwise, SPEC wording that describes *mechanics* (e.g. "Local mode stores
`salt|envelope` in `vmd_data_enc`", sync via Supabase) will need small factual
updates in the same PR as the code. Per Rule 1: if any SPEC line turns out to
*depend* on the current interleaving (rather than describing observable
behaviour), stop and raise it rather than rewriting the SPEC to fit the code.

`README.md`: updated for the TrailBase default and the absence of a backend picker.
`AGENTS.md`: module map, Rule 7, sync and build sections updated (§7 table replaces the
current sync/persistence description).

---

## 12. Rollout

All rows through PR 3 have shipped; row 4 remains optional. The proof column records the
plan-time expectation. §10's "fixture-only" expectation was superseded by the
e2e/integration split (`tests/integration/` holds backend-coupled flows); §14 records the
implementation deviations.

| PR | Content | Proof |
| --- | --- | --- |
| 1 | `docCodec` + `merge` extraction (pure functions; codecs wrap existing `outline.ts`) | unit suite green, e2e unchanged |
| 2a | `storage.ts` contracts + `StoreError` + `encryptedStore`/`KeySession` + memory/file/local adapters + contract suite — **dead code** (the app doesn't import it yet) | unit + contract green; e2e unchanged |
| 2b | `supabaseBackend` (RawStore + AuthProvider, cached-session uid) + `cachedStore` + their contract-suite cases — still dead code | unit + contract green; e2e unchanged |
| 2c | Orchestration cutover for **Memory/File/Local**: `persistence.ts` mode branches construct adapters; `capabilities` gating (`available`/`durable`) replaces scattered feature detection; data-06 surfacing goes live (+ SPEC save-error wording, same commit) | e2e green, **no fixture changes** (only Remote reads the config slot) |
| 2d | Orchestration cutover for **Remote**: `cached()` composition, `vmd_sync_head` slot, deferred queue holds docs, `sync.ts` shrinks to scheduling, slot rename `supabaseconfig` → `backendconfig` + §10's fixture list, sync-01/sync-10 fixes live (+ SPEC pull-before-push wording, same commit) | all e2e green after §10's fixture-only updates |
| 3 (later) | TrailBase backend adapter (`trailbaseBackend.ts`) + config/CSP/CI wiring | new adapter passes contract suite + new e2e against local trail |
| 4 (optional) | `watch(emit)` on SSE-capable `RawStore`s (§4.2) to replace the 60s poll | separate feature — SPEC change, own PR |

Each PR is one atomic change (Rule 9): 1/2a/2b add tested code without
rewiring anything, 2c/2d each cut one mode family over to the seam. The two
declared behaviour exceptions land in **different** PRs — data-06 in 2c,
sync-01 in 2d — so each SPEC wording update ships in exactly the commit that
changes the behaviour. 2c/2d *are* user-visible (quota-error surfacing,
stale-device prompt); the risky Remote cutover is isolated in 2d, where a
problem cannot affect Memory/File/Local users already on the new seam.

Deferred follow-up (not a PR in this plan): **server-managed `updated_at`**
and **server-default `user_id`** for the Supabase backend — `BEFORE INSERT OR
UPDATE` trigger (`NEW.updated_at := now()`), `default auth.uid()` on
`user_id` (the uid leaves the client payload entirely — the fully honest form
of §4.2's identity rule), optional column-privilege revokes, adapter switches
to `upsert(…).select()` so `write()` returns the server token, delete the
remaining client-timestamp push bookkeeping, add clock-skew tests. One shared
migration for both columns. Requires a schema change (Rule 4:
`supabase/schemas/outlines.sql` + generated migration) and new skew behaviour,
so it deliberately does **not** ride inside PR 2d's "existing e2e green"
proof. Sequenced with the sync/data findings work (sec-12, sync-04) when that
roadmap item is picked up.

---

## 13. Open questions

1. **`docId`**: reserve the parameter now (cheap insurance for multi-outline
   support) or add only when the feature is specced? Default leaning: don't add
   until SPEC asks (YAGNI), since the retrofit is adapter-only.
2. ~~**Passphrase rotation**~~ — resolved: the app supports it
   (`changePassphrase`); the flow is specified in §6.7 via `KeySession.rotate`,
   and the SPEC note lives in §11.
3. **Backend config UI**: the options panel today exposes no backend settings
   (config comes from `localStorage`). When TrailBase lands, decide whether the
   hosted default stays Supabase or the config ships per-instance.
4. ~~**`vmd_sync_ts` slot**~~ — **resolved**: a new `vmd_sync_head` slot holds
   the token; `vmd_sync_ts` keeps its numeric-baseline semantics untouched
   (see 5).
5. ~~**Merge baseline vs head token**~~ — **resolved (two clocks)**: the
   three-way merge baseline stays numeric (epoch ms `lastSyncedAt`) and
   orchestration-owned in `vmd_sync_ts`; the opaque `head()` change token
   lives in `vmd_sync_head`. The two are never conflated and the token is
   never parsed as a timestamp. Revisit only if a future backend can supply a
   server-managed baseline (server-assigned revision/clock) that beats a
   device-local one — natural companion to the CAS/anti-rollback work
   (sync-04, sec-12).
6. **Server-managed `updated_at` hard vs soft**: when the deferred follow-up
   (§12) lands, does it only override via trigger (soft — a client-supplied
   value is ignored but still accepted), or also revoke client write access to
   the column (hard — the upsert payload stops carrying it)? Leaning:
   trigger + revoke, since TrailBase's STRICT table won't accept a client
   stamp anyway and the adapter should look the same on both backends.
7. **Self-service account deletion** (real `auth.users` removal): needs a
   server-side endpoint or admin flow on every backend, SPEC wording for the
   product behaviour, and a re-authentication decision (does deletion require
   the password/passphrase again?). Deferred until a backend can actually
   implement `deleteUser?()`; today the method is absent everywhere and the
   Supabase `auth.users` record survives by design.
8. **Offline Remote unlock**: `cached().unlock` is primary-only (§4.7), so an
   offline reload of a Remote document fails at the lock screen exactly as
   today. Enabling cache-fallback verification is a new capability — SPEC
   wording plus offline-unlock e2e — and must decide the stale-cache UX:
   unlock against a cache written under the *old* passphrase, then
   `remote-rekeyed` on the first online pull re-locks and prompts (composes
   cleanly with the sync-01 fix). Deferred to its own PR.

---

## 14. Implementation deviations (recorded during rollout)

Decisions taken while implementing the PRs, where this document's draft was
ambiguous or conflicted with AGENTS rules. The design intent is unchanged.

1. **`RawStore` carries `capabilities`** (§4.2 shows it without): §4.3 requires
   `encrypted()` to inherit durable/available/authenticated/changeDetection from
   the inner raw store, so the adapter contract exposes the descriptor directly.
   Raw-level descriptors always report `encrypted: false`; the decorator sets it.
2. **`KeySession` is the secret-retention point, not a key cache** (§4.3): Rule 7
   requires all crypto through `crypto2.ts`, whose `encrypt`/`decrypt` take
   `(text, passphrase, salt)` — so the multi-entry (salt, iterations) key cache
   lives inside crypto2 (bounded LRU, 4 entries; same sync-10 outcome).
   `keyFor()` is dropped; `activate(passphrase, salt)` / `rotate(newPassphrase)`
   (sync, lazy derivation) / `lock()` remain, plus `activeCredentials()` for
   crypto2 calls.
3. **A locked store's `read()`/`write()` throw `StoreError('unauthenticated')`**
   — the taxonomy (§4.4) has no dedicated 'locked' code; an un-unlocked session
   is modelled as unauthenticated.
4. **`docCodec.parse` throws `StoreError`** (`invalid-document` /
   `unsupported-runtime`) with the typed error preserved as `cause`, per §4.6.
   PR 1 shipped the codecs throwing the raw typed errors because `storage.ts`
   did not exist yet; PR 2a introduced the wrap.
5. **`encrypted()` returns an `EncryptedStore`** (a `StringStore` with required
   `unlock`/`lock`) so consumers don't fight optional-method typing.
6. **First-time setup is `unlock()` on an empty store** (adoption with a fresh
   salt, persisted by the first write) rather than a separate setup primitive —
   this is §6.2's "setup wraps the first write" realised with the existing
   lock-screen entry point.
7. **`unlock()` returns an `UnlockResult`** (`{ text, headToken }`, docs §14):
   the design's void-returning unlock would force a second raw read for the
   document, which the sync fixtures (one download at unlock) and the real
   server both model as a single round-trip. The encrypted decorator returns
   what it already decrypted plus the downloaded record's own change token;
   `codecStore()` and `cached()` pass it through, so the orchestration calls
   the composed store and never keeps a string-level handle on the primary.
8. **`remote-rekeyed` is verified, not assumed** (§4.4): a foreign salt alone
   does not throw — the decrypt is attempted with the session's passphrase;
   a failure *combined with* a foreign salt maps to `remote-rekeyed`. Rotation
   changing both salt and passphrase remains the design premise, but the seam
   cannot assume it: different-salt-same-passphrase flows (independent device
   setup) legitimately decrypt.
9. **`retryWithBackoff` skips typed non-retryable failures** (§6.4): only
   `network`/`unauthenticated` are retried; `remote-rekeyed`, `too-large` and
   friends throw immediately.
10. **The offline-cache priming at unlock is cache-side only** — no upsert at
   unlock time (today's behaviour: the row is written only by saves).
11. **During continuous typing the whole `write()` is deferred** (cache and
    primary together), rather than deferring only the primary write. The
    deferred flush lands ~50ms after the typing gate opens, so the local cache
    write is delayed by well under a second in the worst case.
12. **Memory mode keeps no store instance** (`codecStore(jsonCodec,
    memoryStore())` is the composition template the other modes follow): the
    live outline *is* the Memory store. It is already RAM-only, survives no
    reload (non-goal), and has no unlock lifecycle, so a second codecStore-backed
    copy would duplicate the document in RAM and re-serialize it on every save
    for no observable effect. The intro still round-trips through `jsonCodec` on
    load (validation for free), and `memoryStore()` remains the RAM adapter the
    contract suite exercises. Local and File compose their DocStores exactly as
    §5 describes; their read/write paths are doc-level.
