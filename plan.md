# Agent Handoff Plan

## Context
This plan is for taking over the pending work requested by the user.

User asked for 6 things:
1. Verify whether PWA and background sync are implemented; if yes, move from ROADMAP to SPEC technical details.
2. Enumerate the most important SPEC behaviors still missing E2E coverage.
3. Plan and implement a deep developer statistics panel on `Ctrl+Alt+D`, replacing `?debug=true`.
4. Plan and fix first-load URL hash behavior.
5. Adjust VMD paste behavior:
   - Pasting in description must always be plain paste (never create nodes).
   - Single-line paste without leading `-`/`+` must be native plain paste in node text.
6. Add mobile behavior: when the virtual keyboard is visible, the status bar must stay visible above the keyboard.

## Locked Decisions (already confirmed with user)
- ROADMAP handling: split the combined item.
  - Offline shell caching is considered implemented and should move to Technical considerations.
  - Queued background sync replay on reconnect remains in ROADMAP.
- Debug activation: strict replacement.
  - Remove `?debug=true` activation path.
  - Use `Ctrl+Alt+D` only.
- Single-line paste without leading `-`/`+`: native paste-at-caret behavior.
- Testing policy: each phase must include and pass focused tests before moving on, followed by one final full test run.

## Verified Findings

### 1) PWA/background sync status
Implemented now:
- Service worker registration on load in `source/index.html`.
- App-shell and static asset caching in `source/sw.js`.
- Offline status signaling (`syncStatus = offline`) in sync flow.
- Polling and retry/backoff exist for remote sync.

Not implemented now:
- No persisted queue of failed remote writes for replay after reconnect.
- No Background Sync API registration/replay path in service worker.

Conclusion:
- The ROADMAP item is partially complete and must be split, not fully removed.

### 2) First-load hash behavior
- `applyHashZoomIfPresent()` exists in `source/js/persistence.js`.
- Local and remote unlock paths call it.
- `unlockMemory()` does not call it (likely first-load deep-link bug).
- Filesystem unlock only calls it in non-empty-file branch.

### 3) Paste behavior
- Node text input currently intercepts paste and always calls `outline.setVMD(...)`.
- Description textarea currently uses normal textarea behavior (no VMD parser), but must be explicitly protected against future regressions.
- `setVMD()` treats non-bullet lines as descriptions, which causes undesirable behavior for single-line plain text pastes if always routed through parser.

### 4) E2E gaps to prioritize
High-priority missing/weak scenarios:
- Service worker offline shell behavior (real offline navigation/cached boot).
- Memory-mode first-load hash deep-link restore.
- Filesystem empty-file hash behavior.
- Paste behavior matrix:
  - Description paste never creates nodes.
  - Single-line plain paste in node text remains native.
  - Multi-line bullet paste in node text still creates structure.
- Zoom browser history behavior (back/forward with hash-based zoom semantics).
- Mobile search activation gesture from SPEC (scroll-up behavior).
- Sync polling pause/resume while conflicts are pending, and additional merge edge cases.
- Mobile virtual keyboard + status bar positioning behavior.

### 5) Mobile keyboard/status bar behavior
- No explicit keyboard-aware status bar positioning rule is currently implemented in this plan.
- This needs a dedicated implementation/test phase so mobile editing keeps the status bar visible above the virtual keyboard.

## Implementation Plan

## Testing Strategy (mandatory)
1. Every phase includes a focused test gate.
2. A phase is only considered complete when its gate passes.
3. After all phases pass, run one final full test run (`npm test`).

## Phase 1 - Documentation alignment
Goal: Make SPEC/README match current behavior and decisions.

1. Update `docs/SPEC.vmd` Technical considerations:
   - Add explicit statement that SW caches app shell/static assets for offline load.
   - Keep background sync queue/replay as pending if not implemented.
2. Update `docs/SPEC.vmd` debug text:
   - Replace `?debug=true` behavior with shortcut-driven developer panel (`Ctrl+Alt+D`).
3. Update `docs/SPEC.vmd` ROADMAP:
   - Remove or rewrite combined "Offline PWA & background sync" into:
     - completed offline caching (moved to technical details)
     - pending queued reconnect sync
4. Replace generic missing-coverage sentence with a prioritized checklist (items above).
5. Update `README.md` debug activation wording to shortcut-based panel.
6. Update SPEC/README mobile behavior text: on mobile, when keyboard is visible, status bar remains above keyboard.

Deliverable:
- Docs accurately represent implementation and planned direction.

Phase test gate:
- `npm run test:e2e -- tests/shell.spec.ts`

## Phase 2 - Developer panel architecture (`Ctrl+Alt+D`)
Goal: Replace query-flag debug with runtime-toggleable dev panel.

1. Add a dedicated dev-state module (new file, suggested: `source/js/devtools.js`) with:
   - `devPanelOpen` signal
   - lightweight telemetry signals/records (sync timings, crypto timings, storage stats, runtime state)
2. Instrument data producers:
   - `source/js/sync.js`: last sync timestamp, retry counts, last error, poll run time, conflict counts.
   - `source/js/crypto2.js`: encrypt/decrypt duration samples.
   - `source/js/outline.js`: statistics helpers (node count, max depth, words/chars, collapsed/open counts).
   - `source/js/persistence.js`: unlock mode timing and hash-apply result info.
3. Replace query-gated debug rendering in `source/js/ui.js` with a `DeveloperPanel` component that reads dev signals.
4. Add panel styles in `source/css/style.css`.

Panel sections (developer-focused):
- Outline stats
- Focus/zoom/search runtime state
- Sync diagnostics
- Crypto timings
- Storage/quota estimate
- Focused node raw JSON

Deliverable:
- Dev panel toggles at runtime and shows deep diagnostics without URL query params.

Phase test gate:
- `npm run test:e2e -- tests/debug.spec.ts`

## Phase 3 - Shortcut migration
Goal: Strictly remove query-based debug activation.

1. In `source/js/shortcuts.js`:
   - add `Ctrl+Alt+D` handler to toggle `devPanelOpen`.
2. In `source/js/utils.js` and `source/js/crypto2.js`:
   - remove `URLSearchParams(...).get('debug')` activation dependencies.
   - if logging gate remains, tie it to runtime dev toggle only.
3. In `source/js/ui.js`:
   - remove `isDebug` query check.

Deliverable:
- Only shortcut toggles the panel; `?debug=true` has no effect.

Phase test gate:
- `npm run test:e2e -- tests/debug.spec.ts tests/keyboard.spec.ts`

## Phase 4 - Hash-first-load fixes
Goal: Ensure startup respects URL hash consistently.

1. In `source/js/persistence.js`:
   - call `applyHashZoomIfPresent()` inside `unlockMemory()` after outline load and before unlocking state finalization.
2. Normalize `unlockFilesystem()`:
   - apply hash regardless of empty/non-empty file branch.
3. Preserve invalid-hash behavior:
   - if hash node does not exist, remain at root.

Deliverable:
- First-load deep links work in memory and filesystem flows.

Phase test gate:
- `npm run test:e2e -- tests/memory.spec.ts tests/file.spec.ts tests/zoom.spec.ts`

## Phase 5 - Paste behavior changes
Goal: Make paste behavior deterministic and spec-aligned.

1. In `source/js/ui.js` node text paste handler:
   - decide parser vs native paste by clipboard shape.
   - if single line and no leading `-`/`+`, do native paste.
   - if multi-line/bullet-structured VMD, keep `setVMD` path.
2. Description textarea:
   - ensure plain paste only and never route through `setVMD`.
   - add guard test so this cannot regress.

Deliverable:
- Description paste is always plain text.
- Single-line plain paste in node text behaves like native input.
- Structured VMD paste still works.

Phase test gate:
- `npm run test:e2e -- tests/description.spec.ts tests/keyboard.spec.ts`

## Phase 6 - Mobile status bar above keyboard (mobile)
Goal: Keep the status bar visible above the virtual keyboard while editing on mobile.

1. Implement keyboard-aware status bar positioning in `source/js/ui.js` + `source/css/style.css`.
2. Use `window.visualViewport` when available to detect keyboard overlap and apply a dynamic bottom inset.
3. Keep desktop behavior unchanged and avoid layout jumps.
4. Add mobile E2E coverage to verify the status bar remains visible above keyboard during input focus.

Deliverable:
- On mobile, focusing an input with the keyboard visible keeps the status bar above the keyboard.

Phase test gate:
- `npm run test:e2e -- tests/mobile-indent.spec.ts`

## Phase 7 - Tests and verification
Goal: Final regression lock after all phase gates pass.

Target test updates/additions:
- `tests/debug.spec.ts`
  - remove `?debug=true` assumptions
  - add `Ctrl+Alt+D` show/hide tests
- `tests/memory.spec.ts`
  - add first-load hash deep-link case in memory mode
- `tests/file.spec.ts`
  - add hash behavior for empty-file reopen path
- `tests/description.spec.ts`
  - add description paste does not create nodes
- `tests/keyboard.spec.ts` or `tests/outliner.spec.ts`
  - single-line plain paste in node text is native
- `tests/mobile-indent.spec.ts` and/or a dedicated mobile status-bar spec
   - status bar stays above keyboard while editing on mobile
- new or existing paste-focused spec if needed
  - multi-line bullet paste still creates expected structure
- backlog in this cycle or next:
  - SW offline behavior test
  - zoom back/forward history behavior
  - mobile scroll-up search activation
  - sync polling pause/resume during conflicts and merge edge cases

Run order:
1. Confirm all per-phase focused gates passed.
2. Full E2E suite.
3. Unit harness (`source/test.html` via Playwright).
4. Final full test run (`npm test`).

## File Touch List
- `docs/SPEC.vmd`
- `README.md`
- `source/js/shortcuts.js`
- `source/js/ui.js`
- `source/js/persistence.js`
- `source/js/sync.js`
- `source/js/crypto2.js`
- `source/js/utils.js`
- `source/js/outline.js`
- `source/css/style.css`
- `tests/mobile-indent.spec.ts` and/or new mobile status-bar spec
- `tests/debug.spec.ts`
- `tests/memory.spec.ts`
- `tests/file.spec.ts`
- `tests/description.spec.ts`
- `tests/keyboard.spec.ts` and/or `tests/outliner.spec.ts`
- optional new module: `source/js/devtools.js`

## Acceptance Criteria Mapped to User Request
1. PWA/background sync statement is corrected in SPEC and ROADMAP split is done.
2. SPEC includes prioritized missing E2E behaviors list.
3. Developer panel opens with `Ctrl+Alt+D`, deep stats visible, query flag removed.
4. First load respects URL hash in memory and filesystem paths.
5. Paste behavior matches requested rules and is covered by tests.
6. On mobile, status bar stays visible above keyboard while editing and is covered by E2E.

## Out of Scope for this cycle
- Implementing true queued background sync replay on reconnect (can be separate feature implementation).

## Validation Commands
- Phase 1 gate: `npm run test:e2e -- tests/shell.spec.ts`
- Phase 2 gate: `npm run test:e2e -- tests/debug.spec.ts`
- Phase 3 gate: `npm run test:e2e -- tests/debug.spec.ts tests/keyboard.spec.ts`
- Phase 4 gate: `npm run test:e2e -- tests/memory.spec.ts tests/file.spec.ts tests/zoom.spec.ts`
- Phase 5 gate: `npm run test:e2e -- tests/description.spec.ts tests/keyboard.spec.ts`
- Phase 6 gate: `npm run test:e2e -- tests/mobile-indent.spec.ts`
- Final regression pass: `npm run test:e2e -- tests/sync.spec.ts`, `npm run test:unit`, `npm test`

## Notes for Next Agent
- use source/js/ui.js for active UI edits unless a dependency proves otherwise.
- Keep changes minimal, behavior-driven, and phase-based; run relevant tests after each phase.
- If SW/offline E2E is flaky in CI, use deterministic mocks or split into a dedicated reliability task.
- If any SPEC contradiction appears during implementation, stop and request clarification before proceeding.
