# Sync & Conflict Resolution — Implementation Plan

Overhaul remote sync to add periodic polling, pull-before-push, and node-level merge with a blocking conflict resolution modal.

Uses per-node `lastModified` timestamps + a single `lastSyncedAt` timestamp to detect which side changed each node. Direct value comparison for fields on nodes modified by both sides.

---

## Decisions

| Topic | Decision |
|---|---|
| **Polling** | 60s background poll (lightweight `updated_at` query); also check before every push |
| **Conflict UX** | Blocking modal — per-field "Keep local" / "Keep remote", plus bulk "All local" / "All remote" buttons |
| **Unresolved dismiss** | Blocked — must resolve all conflicts (or bulk-pick a side) before continuing |
| **Merge strategy** | Per-node `lastModified` + single `lastSyncedAt` — no manifest, no hashes |
| **`open` state** | Last-writer-wins (newer `lastModified`), never a conflict |
| **Children conflicts** | Normal conflict field; child IDs decoded to node text for human-readable display |

### Merge logic summary

- Node modified only on one side → that side wins entirely
- Node modified on both sides → direct field comparison; same value = ok, different value = conflict
- Tradeoff: same-node different-field edits become conflicts instead of auto-merging (acceptable for personal outliner)

---

## Phase 1 — Data Model: Node `lastModified` + `lastSyncedAt`

### Implementation

1. In `outline.js` `NodeModel`, add a `lastModified` property (epoch ms, default `0`)
2. `node.update()` sets `lastModified = Date.now()` when any field actually changes
3. `toggleOpen()`, `addChild()`, `removeChild()`, `move()` set `lastModified` on affected nodes
4. `serialize()` includes `lastModified` per node (omit when `0` for backwards compat)
5. `deserialize()` reads `lastModified` (default `0` for old docs — no version bump needed)
6. Add `store.syncTs` slot in `utils.js` for `vmd_sync_ts` (stores `lastSyncedAt` as epoch ms string)

### Files

- `source/js/outline.js` — `NodeModel`, `serialize()`, `deserialize()`, mutation methods
- `source/js/utils.js` — add `store.syncTs` slot

### Tests (unit — `outlineTests.js`)

- `lastModified` is set to non-zero on `addChild()`
- `lastModified` is set to non-zero on `node.update()` when text changes
- `lastModified` is set to non-zero on `node.update()` when description changes
- `lastModified` is unchanged by `node.update()` when no fields change
- `lastModified` is set on `toggleOpen()`
- `lastModified` is set on parent when `removeChild()` / `move()` modifies children
- `serialize()` includes `lastModified` when non-zero
- `serialize()` omits `lastModified` when `0`
- `deserialize()` reads `lastModified` from payload
- `deserialize()` defaults `lastModified` to `0` when absent (old docs)

---

## Phase 2 — Merge Algorithm (`source/js/sync.js` — new file)

### Implementation

1. Create `source/js/sync.js` per agents.md module map
2. Implement `mergeDocuments(localNodes, remoteNodes, lastSyncedAt)`:
   - Input: local node array (from `serialize()`), remote node array (from decrypted remote), `lastSyncedAt` ms
   - Returns `{ merged: nodeArray, conflicts: [{ nodeId, nodeText, field, localValue, remoteValue }] }`
3. Merge logic per node:

   | Condition | Action |
   |---|---|
   | Only in local, `lastModified > lastSyncedAt` | New locally → add to merged |
   | Only in local, `lastModified <= lastSyncedAt` | Deleted remotely → omit |
   | Only in remote, `lastModified > lastSyncedAt` | New remotely → add to merged |
   | Only in remote, `lastModified <= lastSyncedAt` | Deleted locally → omit |
   | Both exist, only local modified | Take local entirely |
   | Both exist, only remote modified | Take remote entirely |
   | Both exist, both modified | Per-field direct comparison (see below) |
   | Both exist, neither modified | Take either (identical) |

4. Per-field comparison (when both sides modified the same node):
   - `text`: same → ok; different → conflict
   - `description`: same → ok; different → conflict
   - `children`: same → ok; different → conflict (decode IDs → node names for UI)
   - `open`: take the version with newer `lastModified` (never a conflict)

5. After merge, validate tree integrity (no orphan parents, no cycles)

### Files

- `source/js/sync.js` — new: `mergeDocuments()`, conflict detection

### Tests (unit — `syncTests.js` — new file)

- No conflicts: only one side modified a node → merged silently
- Auto-merge: different nodes modified on each side → no conflicts
- Field conflict: same node, same field (`text`), different values → conflict entry
- Field conflict: same node, same field (`description`), different values → conflict entry
- Children conflict: same node, different `children` arrays → conflict entry
- Same node, same field, same value → no conflict
- Node added locally, not in remote → included in merged
- Node added remotely, not in local → included in merged
- Node deleted locally, unmodified remotely → deleted (omitted from merged)
- Node deleted locally, modified remotely → kept (remote version in merged)
- Node deleted remotely, unmodified locally → deleted
- Node deleted remotely, modified locally → kept (local version in merged)
- `open` state uses newer `lastModified`, never produces conflict
- Old docs (`lastModified = 0`) treated as unmodified relative to any `lastSyncedAt > 0`
- Root node is never deleted even if absent on one side
- Tree integrity validated after merge (no orphan `parentId` references)

Register `syncTests.js` in `source/test.html`.

---

## Phase 3 — Conflict Resolution UI

### Implementation

1. In `sync.js`, export signals:
   - `pendingConflicts` — array of `{ nodeId, nodeText, field, localValue, remoteValue }`
   - `pendingMergedDoc` — merged node array awaiting conflict resolution
2. In `ui.js`, add `ConflictModal` component:
   - Shown when `pendingConflicts.value.length > 0`
   - Blocking modal (reuses `.modal-overlay` / `.modal-dialog` pattern from `OptionsModal`)
   - Header: "Sync conflicts" + count
   - Body: scrollable list, each conflict shows:
     - Node identification (node text or ancestor breadcrumb path)
     - Field name ("Text", "Description", "Children")
     - Side-by-side: local value (left) | remote value (right) in monospace read-only textareas
     - For children field: ordered list of child node names instead of raw IDs
     - Button per conflict: "Keep local" / "Keep remote"
   - Footer: **"Use all local"** | **"Use all remote"** | **"Apply"** (enabled when all resolved)
3. Render `ConflictModal` in `app.js` main tree (alongside OptionsModal)
4. `sync.resolveConflicts(resolutions)`:
   - Applies chosen values to `pendingMergedDoc`
   - Deserializes merged doc into outline
   - Triggers push + updates `lastSyncedAt`
   - Clears `pendingConflicts`

### Files

- `source/js/sync.js` — `pendingConflicts`, `pendingMergedDoc`, `resolveConflicts()`
- `source/js/ui.js` — `ConflictModal` component
- `source/js/app.js` — render `ConflictModal` in tree
- `source/css/style.css` — conflict modal styles (side-by-side layout)

### Tests (E2E — `sync.spec.ts`)

- Conflict modal appears when both sides modified same node's text
- Modal blocks interaction with outline beneath (overlay captures clicks)
- Each conflict shows node text, field name, local value, remote value
- Children conflict displays decoded node names, not raw IDs
- "Keep local" / "Keep remote" buttons toggle per-conflict resolution
- "Use all local" resolves all conflicts with local values
- "Use all remote" resolves all conflicts with remote values
- "Apply" is disabled until all conflicts are resolved
- After "Apply", outline reflects chosen resolutions and `pendingConflicts` is empty
- Auto-merge (different nodes modified on each side) → no modal, merged silently

---

## Phase 4 — Pull-Before-Push + Periodic Polling

### Implementation

1. `checkRemoteNewer(lastSyncedAt)`:
   - Call `remoteSync.getLastUpdate()` → compare `updated_at` with `lastSyncedAt`
   - Returns boolean
2. `pullAndMerge(passphrase, salt)`:
   - Fetch + decrypt remote data
   - Serialize current local outline
   - Run `mergeDocuments(local, remote, lastSyncedAt)`
   - No conflicts → apply merged doc, push merged result, update `lastSyncedAt`
   - Conflicts → set `pendingConflicts` + `pendingMergedDoc`, block push
3. Refactor `persistence.js` sync effect:
   - **Current**: edit → 1s debounce → encrypt → push
   - **New**: edit → 1s debounce → `checkRemoteNewer()` → if newer: `pullAndMerge()` → if clean: encrypt merged → push → update `lastSyncedAt`; if conflicts: block push, show modal
   - If no remote changes → push directly → update `lastSyncedAt`
4. 60s background polling:
   - `startPolling()` / `stopPolling()` via `setInterval`
   - Calls `checkRemoteNewer()` → `pullAndMerge()` if needed
   - Only active in remote mode + online
   - Pauses when `pendingConflicts` is non-empty (don't stack pulls)
   - Starts on remote unlock, stops on sign-out/lock
5. Extract `remoteSync` from `persistence.js` as importable module for `sync.js`

### Files

- `source/js/sync.js` — `checkRemoteNewer()`, `pullAndMerge()`, polling
- `source/js/persistence.js` — refactor sync effect, expose `remoteSync`

### Tests (E2E — `sync.spec.ts`)

- Pull-before-push: inject remote data with newer `updated_at` via mock → verify local doc updated before push
- Push without pull: remote `updated_at` older → push proceeds without pull
- 60s polling: inject delayed remote update → verify auto-pull after interval
- Polling pauses during pending conflicts (no stacked pulls)
- Polling stops on sign-out / lock
- `syncStatus` transitions: synced → syncing → synced (or error/offline)
- Existing sync indicator tests updated for new push flow (extra `getLastUpdate` mock call)
- Recover after conflict resolution: push completes after modal "Apply"

---

## Phase 5 — SPEC & README Updates

### SPEC.vmd changes

1. Replace SYNC BEHAVIOUR section:
   - Pull-before-push on every write
   - 60s background polling for `updated_at`
   - Per-node `lastModified` timestamps
   - Node-level merge with field-level comparison
   - Conflict resolution via blocking modal (per-field + bulk buttons)
   - Remove "three-way merge using the last-synced base as the common ancestor" language
2. ROADMAP: remove "sync conflict resolution is non-existent" from Bugs
3. ROADMAP: remove sync conflict resolution UX from Questions to clarify (resolved: blocking modal, must resolve before continuing)

### README.md changes

- Update sync bullet points to reflect pull-before-push, polling, and conflict resolution

### Files

- `docs/SPEC.vmd`
- `README.md`

---

## Scope boundaries

| Included | Excluded |
|---|---|
| Periodic polling (60s `updated_at` check) | Real-time subscriptions (Supabase realtime) |
| Pull-before-push on every write | Offline queue / PWA |
| Node-level merge with field comparison | Smart ordered-list children merging |
| Blocking conflict resolution modal | Structural move conflicts |
| Per-node `lastModified` timestamps | Database schema changes |
| SPEC / README updates | Multi-device presence |
| Unit + E2E tests for all phases | |
