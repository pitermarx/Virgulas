# Storage Interface — Design Document

Status: implemented — this document is the storage seam's contract.
Scope: persistence/sync internals, the documented data-06 and sync-01 behaviour
  fixes, and the TrailBase backend. TrailBase on the serving origin is the
  default; Supabase remains the static-deployment fallback.

---

## 1. Goals and non-goals

### Goals

1. One `DocStore` contract that Local/Remote/File/Memory and further backends
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

## 3. Architecture

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
│   built-ins: file; composed: local, remote                   │
│   representation: OutlineDoc above, strings below the codec, │
│     opaque records below the crypto line                     │
├──────────────────────────────────────────────────────────────┤
│ RawStore (backend adapter contract — below both lines)       │
│   adapters: localStorage slot, supabase, trailbase           │
│   representation: opaque record { data, salt?, updatedAt? }  │
│   at rest: envelope around codec output (or plain bytes)     │
└──────────────────────────────────────────────────────────────┘
```

Identity: `AuthProvider` is a separate contract implemented only by
authenticated backends; it never touches documents.

Crypto rule (AGENTS Rule 7) holds structurally: all encryption lives in
`crypto2.ts` plus one decorator module that calls it. No adapter, no
orchestration code ever performs crypto.

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
   *  through unchanged. Throws StoreError('wrong-key'). */
  unlock?(passphrase: string): Promise<UnlockResult | void>
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
   * itself never throws for environment reasons.
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
  separate "verify passphrase" primitive — decryption is the verifier.
- **`UnlockResult`** — `unlock()` resolves with `{ text, headToken }`: the
  at-rest payload it already decrypted (`null` when the store was empty —
  first-time setup adoption) plus the downloaded record's own change token, so
  the orchestration can adopt exactly the state it loaded. Unlock is one
  round-trip — no separate read — and every decorator passes the result
  through unchanged, so the caller never keeps a string-level handle on the
  inner store.

### 4.2 `RawStore` — the backend adapter contract (below the crypto line)

Backend adapters (localStorage, Supabase, TrailBase, user-defined) implement
this. They store opaque records; they never see plaintext documents and never
see the outline model. There is no user-facing backend choice: the server is
TrailBase on the origin serving the app (`trail run --public-dir dist`),
resolved automatically in the remote flows (override slot → same-origin probe
→ hosted Supabase fallback).

```ts
// source/js/storage.ts
export interface RawRecord {
  /** Opaque payload: ciphertext envelope for encrypted backends, plain VMD otherwise. */
  data: string
  /** Opaque auxiliary field the encrypted decorator uses (the salt). */
  salt?: string
  /** Modification stamp assigned by the adapter (client clock on both
   *  backends — documented limitation, §5). */
  updatedAt?: string
}

export interface RawStore {
  readRaw(): Promise<RawRecord | null>          // null = no record
  // upsert; the adapter assigns updatedAt (client clock — §5
  // limitation). Resolves with the new head token (the value head() would now
  // report), or null if untracked.
  writeRaw(record: RawRecord): Promise<string | null>
  clearRaw(): Promise<void>
  exists(): Promise<boolean>                     // no key/session required
  head?(): Promise<string | null>
  /** Push-based change notification (SSE-capable backends). Emits the new
   *  head token on remote change; the returned function unsubscribes.
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
(`auth.getSession()`, no network round-trip), and RLS `with check (auth.uid() =
user_id)` server-verifies that the value equals the JWT's, so it cannot be
forged. Removing it from the wire entirely (`default auth.uid()`) needs a
migration and is open work (§12).

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

Responsibilities:

1. **Serialize at rest** — emits the envelope `v2:<iterations>:<base64(iv‖ct)>`
   and carries the salt in `RawRecord.salt`. The inner adapter decides where the
   salt physically lives (localStorage slot prefix, DB column, or inline) — from
   above, it is opaque either way.
2. **KDF lifecycle and salt policy** — derived keys are cached inside
   `crypto2` (multi-entry, bounded LRU, keyed by (passphrase, salt,
   iterations)), so autosave never re-runs the 600k PBKDF2 and alternating
   salts cost one derivation each, not one per operation (fixes sync-10).
   Local and Remote share one `KeySession` (one passphrase). Their salts are
   *usually* equal but **can diverge**: a passphrase rotated on another
   device puts a foreign salt in the remote row. Rotation changes salt and
   passphrase together, so a record whose salt differs from the session's
   `activeSalt` normally cannot decrypt under the retained passphrase — but
   the failure is **verified, not assumed**: the decrypt is attempted with the
   session's passphrase, and only a GCM failure *combined with* a foreign
   salt maps to the typed `remote-rekeyed` error (§4.4) instead of failing
   silently and letting the next push overwrite the rotated remote (fixes
   sync-01). Different-salt-same-passphrase flows (independent device setup)
   legitimately decrypt. The key cache is dropped on `lock()` and on
   `rotate()`, so neither a key nor a passphrase — the cache key embeds it —
   outlives the session that uses it.
3. **Envelope versions** — only `v2:<iterations>:` envelopes decrypt; a
   payload without the `v2:` header is rejected as corrupt (`corrupt-data`,
   §4.4). A `v2:310000:` envelope decrypts at its recorded iteration count,
   and the next successful save re-encrypts it at current parameters (600k)
   — upgrade-on-save.
4. **WrongKeyError** — GCM auth failure during `unlock()` maps to the typed
   `wrong-key` error the lock screen handles.
5. **Biometrics** — `biometrics.ts` seals/unseals the *passphrase*; the unsealed
   passphrase feeds `unlock()` exactly as typed input does. No change.
6. **Secret retention** — the session passphrase lives **only** inside
   `KeySession` (memory-only; derived keys are non-extractable; on `lock()` the
   passphrase, the active salt and crypto2's derived-key cache are all dropped —
   the cache key embeds the passphrase, so clearing it is part of the invariant —
   and `rotate()` drops the cache too, so the passphrase a rotation replaces does
   not linger until the next lock). Orchestration holds no secrets (Goal 2).

`KeySession` is internal to the crypto layer:

```ts
export interface KeySession {
  /** The salt writes encrypt under this session. Set by a successful
   *  unlock-decrypt, first-time setup, or rotation; null while locked. */
  readonly activeSalt: string | null

  /** True when a passphrase is retained (unlocked, or first-time setup). */
  readonly unlocked: boolean

  /** Make (passphrase, salt) the active pair — a successful unlock or setup. */
  activate(passphrase: string, salt: string): void

  /** Rotation / setup with a fresh salt: a fresh salt is generated and the
   *  new passphrase becomes active. Subsequent writes re-encrypt everything
   *  under the new key (§6.7); derivation itself is lazy, after the previous
   *  key cache is dropped. */
  rotate(newPassphrase: string): void

  /** Drop the passphrase, the active salt and every cached derived key
   *  (lock, sign-out, teardown). */
  lock(): void

  /** Credentials for crypto2 calls; null while locked. */
  activeCredentials(): { passphrase: string; salt: string } | null
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
as `cause`, so the lock screen's `instanceof` branches keep working.

Adapter mapping: Supabase `PGRST116` → `not-found` (surfaced as `read() → null`);
401s → `unauthenticated`; transport failures → `network` (retryable — the
orchestration's backoff keys off this); a size-cap rejection — the per-account plan cap or the
absolute row cap — surfaces as a check violation (23514) → `too-large`
(adapters enforce their own bounds, mirroring the SQL constraints); a
localStorage quota failure in the local slot → `too-large` as well, surfaced
instead of swallowed (fixes data-06).
TrailBase: 401/403 → `unauthenticated`, 404 → `not-found`, every other 4xx
except 408/429 → `invalid-input` (a malformed email, password-policy rejection,
conflicting write — retrying the same request cannot succeed), while 408/429
and 5xx/transport failures → `network` (retryable).
Codec parse failures after a successful decrypt → `invalid-document` (raised by
the codec, §4.6). A pulled record whose salt differs from the session's
`activeSalt` **and** fails to decrypt under the session passphrase →
`remote-rekeyed`: another device rotated the passphrase (a foreign salt alone
is not sufficient — §4.3). It is never swallowed and never followed by a
push — the orchestration locks the session and prompts for the new passphrase
(fixes sync-01). GCM failure during `unlock()` maps to `wrong-key`.

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
no adapter currently raises it (account deletion is **not** modelled
this way — it is `auth.deleteUser?()` absence, §4.5).
The destructive-reset offer (`canResetRemoteData`) triggers on
`code === 'wrong-key'` **only** — not on `corrupt-data` (no passphrase is
wrong) and not on `remote-rekeyed` (resetting would clobber the rotated
remote; prompt for the new passphrase instead). That tightening is the same
bug class as the sync-01 fix.

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
  `utils.ts` (Rule 7). Both adapters do: TrailBase keeps its tokens in
  `store.backendSession`; the Supabase adapter passes an `auth.storage` adapter
  to `createClient` that holds supabase-js's own `sb-<ref>-*` keys as one JSON
  map in `store.supabaseSession` (so the SDK never writes a bare localStorage
  key), and it adopts — then deletes — a key an older build wrote directly. The
  device wipe clears both slots and sweeps any leftover `sb-*-auth-token` key.
- `getUser()` is the **server-verified** probe (a network round-trip on
  Supabase): boot and session checks use it; the write path must not. The
  Supabase adapter sources its uid from the cached session (§4.2).
- The product's **Delete account** flow is an orchestration sequence:
  1. require a signed-in user (typed `unauthenticated` error otherwise),
  2. **quiesce**: stop polling, clear pending saves and credentials — so an
     in-flight upload cannot resurrect the deleted row,
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
  unchanged / deleted; same-field edits conflict. The baseline is
  orchestration-owned sync state, **not** a store property, and must not be
  conflated with the opaque `head()` token — two clocks, two slots (§8).
- Memory mode keeps no store instance: the live outline itself is the Memory
  store — it is already RAM-only, survives no reload (non-goal), and has no
  unlock lifecycle, so a codecStore-backed copy would duplicate the document
  in RAM for no observable effect. The tour loads straight through `vmdCodec`
  into the model. Local and File compose their DocStores exactly as §5
  describes.

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
| `write(doc)` | cache first, then primary; resolve with the primary's token | the durable local copy is written first, then the network push |
| primary fails `network` | cache write **stands**; the error propagates | deferral/retry belongs to the orchestration (§6.4); stores do single operations |
| cache fails (quota) | primary is still attempted; with `onCacheWrite` the failure is reported there and the write resolves with the primary token, without it `too-large` propagates | the save is durable remotely but not locally; Remote's hook drives the toolbar's "not saved locally" state (fixes data-06) |
| `read()` | primary; on `network` error fall back to cache | mid-session connectivity-loss reads (an already-unlocked session; offline *boot* stops at the primary-only `unlock` row below). The fallback may be stale — a merge against a stale self-copy is a no-op merge |
| `exists()` | `cache ∥ primary` | offline boot must still show the lock screen |
| `head()` | primary only; errors → orchestration treats as "no change" | change detection is about the source of truth |
| `unlock(pw)` | **primary only**; resolves with the primary's `UnlockResult`; a `network` error fails the unlock — no cache fallback. A foreign-salt primary → `remote-rekeyed` (§4.3) | unlock verifies against the **remote** record: an offline Remote reload needs connectivity. The passthrough means the caller never holds the inner string store. Offline unlock via the cache is a future capability (§13 OQ 8), not a decorator side effect |
| `clear()` | clear both | purge means purge everywhere |

With `write()` taking an `OutlineDoc`, the save edge holds **documents, not
ciphertext**: a Remote save is just `store.write(doc)` behind the sync engine
(Goal 2).

---

## 5. Backend matrix (existing four modes + future)

| Mode | Composition | At-rest shape | Change token (`head`) |
| --- | --- | --- | --- |
| Memory | live outline (no store instance — §4.6) | RAM only | n/a |
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
  (§4.2).
- **`updated_at` is client-supplied**: the adapter stamps
  `new Date().toISOString()`, so the `head()` token inherits client-clock
  trust — not monotone across devices, forgeable by a compromised client, and
  the substrate of sec-12 (no anti-rollback) and sync-04 (no
  compare-and-swap). The seam isolates the limitation inside `supabaseBackend`;
  the TrailBase adapter shares it — it also accepts a client-supplied
  `updated_at`.
- `write()` returns the **server's** `updated_at` representation (the upsert
  selects it back), not the client's `Z`-suffixed string. That keeps the token
  exactly equal to what a subsequent `head()` reports, so the poller does not
  mistake its own push for a remote change; the client-clock trust limitation
  above still applies.
- `docId` is deliberately absent from the contracts. If multi-document support
  is ever wanted, it is added as an optional parameter defaulting to a constant;
  retrofitting later touches only adapters. Deciding now is an Open Question.

---

## 6. Behavioural flows

### 6.1 Boot / mode selection (`persistence.getAuthBootstrap`)

Decision logic (remembered mode + existing-data signals), expressed as: pick a
backend from config → construct its `DocStore` (+`AuthProvider`
if authenticated). The startup-path rule:

- File handle lookup gated on `filesystem` mode.
- Session probe (network) gated on `remote` mode.
- Backends with `capabilities.available === false` are filtered out before
  construction (File on Firefox/Safari): a remembered-but-unavailable mode
  falls back exactly as an unusable remembered mode does — no
  environment errors are ever thrown from constructors.
- The `navigator.storage.persist()` prompt (Safari ITP eviction protection)
  hangs off `capabilities.durable === 'prompt'` and stays an orchestration/
  options-panel concern; stores never call it themselves.

### 6.2 Unlock (Local/Remote)

```
lock screen shown  ⇐ store.capabilities.encrypted && store.exists()
passphrase entered → store.unlock(passphrase)
                      └─ decorator: read salt from at-rest → session.activate(pw, salt)
                         → attempt decrypt → WrongKeyError? reject
                         : unlocked — salt becomes session.activeSalt, key cached,
                           passphrase retained inside KeySession only (§4.3)
document rendered  ⇐ store.read()          // codec parses + validates below the seam
```

First visit (no data): passphrase *setup* wraps the first `write` — the decorator
generates the salt once and reuses it.

### 6.3 Autosave

```
edit → debounce → activeStore.write(doc)   // codec+crypto below; + remote scheduling in Remote mode
```

The derived key comes from the session cache — no KDF per save. A
`v2:310000:` envelope is transparently re-encrypted at 600k on this write. In
Remote mode the write goes through `cached()` (§4.7): the cache write is the
durable local save, and the network push waits for the typing gate; the next
save retries it (§6.4). During continuous typing the whole `write()` — cache
and primary together — is deferred; the deferred flush lands ~50 ms after the
typing gate opens, and the 3 s maximum wait bounds the deferral, so the local
cache write is delayed by well under a second in the worst case and an edit is
never held only in memory. A cache quota failure is reported through the
composition's `onCacheWrite` hook: the remote save completes and the status
toolbar reports the document as not saved locally until the next successful
cache write (data-06).

An unlock is not a save. The document was just read from the store, so the
pipeline marks it saved instead of arming a write: unlocking does not
re-encrypt or re-upload the document it only just decrypted. A legacy
envelope therefore upgrades on the next real save, which is what the SPEC
promises ("a normal save re-encrypts").

### 6.4 Remote poll / pull-before-push (Remote mode)

```
every 60s:  token = remoteStore.head()
            token ≠ lastSeen → doc = remoteStore.read()
                                → merge(localDoc, doc, baseline)      // pure (§4.6)
                                → merged: if content ≠ remote, write remote
                                          apply merged doc locally
                                          lastSeen := written token, or the
                                                      observed head without a write
                                → conflict: blocking modal
            lastSeen updated from every successful write's returned token
```

- `head()` compares an opaque token for change detection only. The numeric
  merge `baseline` (epoch ms, the `vmd_sync_ts` slot) is a second,
  orchestration-owned clock and stays numeric — two clocks, two slots (§8).
- `write()` returning the new head token is what prevents the self-push
  ping-pong: the poller adopts the token its own write produced, so it never
  re-pulls its own update.
- A pull whose merged document equals the remote content is applied locally
  but **not** written back. Without that guard, two open clients would each
  turn the other's poll into a new remote revision every 60 seconds.
- Scheduling, queueing, `remoteSyncNotBefore` backoff, `retryWithBackoff` and
  the merge marker all live in the orchestration, keyed off the typed
  `network`/`unauthenticated` errors. Stores do single operations only.
  `syncEngine.ts` owns the one step: the injected store, the head probe, the
  pull-before-push cycle, the retry policy, the clocks and the conflict
  hand-off. `sync.ts` only schedules the poll and resolves the backend.
- The Remote save edge (`persistence.ts`) keeps the durable local copy first:
  whenever a save lands, the cache write precedes the network push, and the
  network push waits for the typing gate; the next save retries it. There is
  no push queue — an edit is written locally on every save (the 3 s maximum
  wait included), so it is never held only in memory.
- The poll defers to active local edits.

### 6.5 Account deletion, purge, export/import

- **Purge**: `store.clear()` (+ for Local: drop the slot; encrypted state drops
  with it).
- **Account deletion**: the §4.5 orchestration sequence (quiesce → `clear()` →
  optional `deleteUser` → wipe → `signOut()`), with the failure-before-wipe
  ordering preserved; honest messaging via `auth.deleteUser?()` presence.
- **Export/import**: operate on VMD text / `.vmd` files; they use `vmdCodec`
  directly — a store is not involved.

### 6.6 Quick capture

The inbox queue is local metadata (store slot), reconciled into the
document by the model layer; it never touches the store seam. The boot rule stands:
no store is constructed, no network, no KDF until the user confirms.

### 6.7 Passphrase rotation

```
user confirms rotation → doc = store.read()
                        → session.rotate(newPassphrase)   // fresh salt + fresh key,
                                                          // becomes activeSalt
                        → store.write(doc)                // re-encrypts everything
                                                          // under the new key
```

New salt, re-encrypt, push, cache — the secrets never transit orchestration.
A stale device holding the old passphrase meets `remote-rekeyed` on its next
pull (§4.4) and locks with a prompt instead of silently reverting the
rotation (sync-01 fix).

---

## 8. Config and data slots

- **No at-rest data migration.** Existing `v2` envelopes, Supabase rows, and
  `.vmd` files are read as-is by the corresponding adapters; a payload without
  the `v2:` header is rejected as corrupt (§4.3).
- `localStorage.backendconfig`
  (`{ backend: 'supabase' | 'trailbase' | …, url, key }`) is the config slot —
  the only one. When no config is stored, the hosted Supabase constants in
  `storage.ts` are the fallback.
- Two clocks coexist in separate slots: the numeric merge baseline (epoch ms
  — the `vmd_sync_ts` slot) and the opaque `head()` change token (the
  `vmd_sync_head` slot). Token values are never parsed as timestamps;
  baseline values never leave the orchestration.
- All slot access stays behind `store` in `utils.ts` (Rule 7). Naming note:
  the contracts module is `storage.ts` — deliberately **not** `store.ts`,
  so Rule 7's "`store` slots in `utils.ts`" vocabulary stays unambiguous.

---

## 9. Security analysis

1. **Crypto containment (Rule 7).** Key material exists only in `crypto2.ts`,
   `encryptedStore.ts` (which calls `crypto2`), and `biometrics.ts` (device-local
   passphrase seal — the documented exception). `KeySession` is the single
   in-memory retention point for the session passphrase (§4.3); adapters and
   orchestration handle opaque strings only and hold no secrets.
2. **Identity binding.** Orchestration never asserts `user_id`; the backend
   enforces owner-only access (Supabase RLS *rejects* any client-stamped uid
   that doesn't match the JWT; TrailBase ACL `_ROW_.user = _USER_.id`). The
   Supabase adapter sources the uid from the cached session,
   not a per-push `getUser()` round-trip (§4.2). The defense-in-depth grants in
   `outlines.sql` stand.
3. **Test seams.** The `__TEST_HOOKS__` build define gates the
   `window.supabase` seam (a `RawStore`/`AuthProvider` factory hook for specs)
   and the `/js/app.js` `e2e` introspection binding. Production builds compile
   it out; `tests/e2e/e2e-seam.spec.ts` asserts both builds behave.
4. **User-defined backends — policy.** Supported tiers: (a) config-driven
   presets pointing built-in adapters at user-chosen instances (same trust
   model as `backendconfig`), (b) additional built-in protocol adapters
   (WebDAV/S3 class). **Arbitrary user-supplied JS adapters at runtime are
   rejected**: a malicious adapter receives every decrypted document by design,
   and the CSP (`script-src 'self'` + SRI-pinned tracker) exists precisely to
   keep foreign code out. This restriction is documented, not worked around.
5. **Plaintext lifetime.** Serialized text (JSON or VMD) exists only
   transiently inside codec calls and inside stores; the app itself handles
   only the model.
6. **Head-token trust.** For Supabase, `head()`/`write()` tokens are
   client-stamped `updated_at` values (§5 limitation). What the token
   guarantees: changed-vs-unchanged detection between honest clients. What it
   does **not**: anti-rollback (sec-12) or compare-and-swap (sync-04) — a
   compromised client or stolen session can stamp arbitrary tokens. The seam
   confines the weakness to one adapter and gives the fix a single touch
   point (swap the stamp source inside `supabaseBackend`, return the server
   value from `writeRaw`) — §12 open work.

---

## 10. Test coverage (Rule 3)

The seam is guarded by the unit suites in `tests/unit/suites/`:

- `storeContract.test.ts` — the contract conformance suite: every adapter
  (file (fake handle), local slot, encrypted-over-fake-raw, the composed
  local DocStore) runs against the same behavioural spec — upsert semantics,
  exists-without-key, head invariants, typed errors on **both channels**
  (`code` plus the original `crypto2` error in `cause`), and capability
  descriptors. A new backend proves itself against this file.
- `encryptedStore.test.ts` — envelope round-trip, salt reuse, WrongKey
  mapping, key-cache behaviour (uses `__TEST_KDF_SCALE__`), `remote-rekeyed`
  on a foreign-salt pull with **no** upsert afterwards (sync-01 regression),
  rotation flow (§6.7).
- `cachedStore.test.ts` — `cached()` write order, primary `network` failure,
  cache-quota surfacing, offline read fallback, exists-union, head and unlock
  passthrough.
- `docCodec.test.ts` — json/vmd serialize/parse round-trip,
  `invalid-document`, `codecStore` lift behaviour and UnlockResult passthrough.
- `merge.test.ts` — auto-merge same-node different-field, conflict same-field,
  baseline semantics via per-node `lastModified`, pureness (no store calls
  inside merge).
- `supabaseBackend.test.ts` / `trailbaseBackend.test.ts` — adapter mapping
  (PGRST116 → not-found, etc.) with a fake client; auth adapter (`deleteUser`
  absent on Supabase, present on TrailBase); `upsert` sources the uid from
  the cached session.
- `syncEngine.test.ts` — the single pull-before-push step: token adoption,
  retry policy, conflict hand-off.

Playwright journeys exercise the flows through the UI: `tests/e2e/` holds the
behaviour specs, `tests/integration/` the backend-coupled flows through the
mocked `window.supabase` seam.

---

## 12. Open work

Two follow-ups remain, both requiring a schema change (Rule 4:
`supabase/schemas/outlines.sql` + generated migration, one shared migration
for both columns):

- **Server-stamped revision clock** — replace the client-supplied
  `updated_at` with a `BEFORE INSERT OR UPDATE` trigger
  (`NEW.updated_at := now()`), optionally revoke client write access to the
  column, and add clock-skew tests. The adapter half that makes `write()`
  return the server's stamp (`upsert(…).select('updated_at')`) is already in
  place; the fix applies to Supabase and TrailBase consistently. Natural
  companion to the CAS/anti-rollback findings (sec-12, sync-04).
- **Server-default `user_id`** — `default auth.uid()` on `user_id`, so the
  uid leaves the client payload entirely: the fully honest form of §4.2's
  identity rule.

---

## 13. Open questions

1. **`docId`**: reserve the parameter now (cheap insurance for multi-outline
   support) or add only when the feature is specced? Default leaning: don't add
   until SPEC asks (YAGNI), since the retrofit is adapter-only.
3. **Backend config UI**: the options panel exposes no backend settings
   (config comes from the `backendconfig` slot). Decide whether the hosted
   default stays Supabase or ships per-instance.
6. **Server-managed `updated_at` hard vs soft**: when the open-work item
   (§12) lands, does it only override via trigger (soft — a client-supplied
   value is ignored but still accepted), or also revoke client write access to
   the column (hard — the upsert payload stops carrying it)? Leaning:
   trigger + revoke, since TrailBase's STRICT table won't accept a client
   stamp anyway and the adapter should look the same on both backends.
7. **Self-service account deletion** (real `auth.users` removal): needs a
   server-side endpoint or admin flow on the backends that lack it (Supabase
   needs the service role), SPEC wording for the product behaviour, and a
   re-authentication decision (does deletion require the password/passphrase
   again?). TrailBase implements `deleteUser`; the Supabase `auth.users`
   record survives by design.
8. **Offline Remote unlock**: `cached().unlock` is primary-only (§4.7), so an
   offline reload of a Remote document fails at the lock screen. Enabling
   cache-fallback verification is a new capability — SPEC wording plus
   offline-unlock e2e — and must decide the stale-cache UX: unlock against a
   cache written under the *old* passphrase, then `remote-rekeyed` on the
   first online pull re-locks and prompts (composes cleanly with the sync-01
   fix). Open work in its own right.
