# Virgulas — Implementation Plan

## Purpose & scope

A keyboard-first infinite outliner running entirely in the browser.
No server, no build step, single HTML file, data lives in the browser (localStorage).
Export/import via Markdown.
Optional cloud sync via Supabase for signed-in users.

---

## Tech decisions

- **Single HTML file** — HTML + `<style>` + `<script type="module">`. Minimal external dependencies.
- **Vanilla JS** — no framework. Direct DOM manipulation via a thin render layer.
- **Markdown** — a small hand-rolled inline parser (bold, italic, code, links). No external lib needed.
- **Supabase** — loaded via CDN (`@supabase/supabase-js@2`) for authentication and cloud sync. The app functions fully offline if the CDN is unavailable.

---

## Supabase cloud sync

Cloud sync is **opt-in**: it must be explicitly enabled via the **Options → Cloud sync → Enable sync** toggle. When disabled (the default), the app works entirely offline using `localStorage`. The `sync_enabled` flag is persisted in `localStorage`.

When sync is enabled and a user is signed in, the outline data and theme preference are synced to Supabase every 15 seconds.

### Required Supabase table

Run the following SQL in your Supabase SQL editor once:

```sql
CREATE TABLE IF NOT EXISTS outlines (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data       TEXT        NOT NULL,
  version    BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outlines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own data"
  ON outlines FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### Sync behaviour

- **Compression**: data is gzip-compressed with the native `CompressionStream` browser API before storing in Supabase to minimise storage and bandwidth.
- **Poll interval**: every 15 seconds (and immediately when the browser tab regains focus).
- **Version numbers**: each push increments `doc.version`, allowing the client to detect whether the server has newer data.
- **Sync indicator**: a small status label appears between the toolbar spacer and the Options button:
  - *Pending* — unsaved local changes waiting to be pushed.
  - *Syncing…* — network request in progress.
  - *Synced* — last sync completed successfully (fades after 3 s).
  - *Sync error* — network or server failure.
  - *Conflict – click to resolve* — clicking opens the conflict modal.
- **Auto-merge**: when both the local and server versions have changes since the last sync, a 3-way merge is attempted. If the changes affect different nodes (different branches of the tree), the merge succeeds silently.
- **Conflict modal**: if the same node was edited in both versions, the conflict modal opens showing the local and server Markdown side-by-side. Three resolution options are offered:
  - **Keep Local** — push the local version to the server.
  - **Use Server** — replace local data with the server version.
  - **Apply Resolved** — edit the pre-populated "Resolved version" textarea and apply it.
- **Theme sync**: the active theme (light/dark) is included in the sync payload so it stays consistent across devices.
- **First sync**: on the first sync after signing in, if the server is empty the local data is uploaded; if local is empty the server data is downloaded; if both have data the conflict modal is shown.

---

## Data model

```
Node {
  id:          string       // nanoid-style: random base36 + timestamp
  text:        string       // bullet title (inline markdown)
  description: string       // optional multiline note
  children:    Node[]       // ordered child nodes
  collapsed:   boolean      // whether children are hidden
}

Document {
  root:    Node             // invisible root; its children are top-level bullets
  version: number           // schema version for future migrations
}
```

The entire document is one JSON tree. The root node is never shown directly — it is the container for top-level bullets.

---

## State

Three pieces of mutable state

```
doc          — the Document object 
zoomStack    — array of node IDs, from root down to current view (url is source of truth)
focusedId    — ID of the bullet whose text is currently focused (or null)
selectedIds  — ordered array of IDs in the current multi-selection (empty when no selection)
selectionAnchor — ID of the node where the multi-selection started (null when no selection)
selectionHead   — ID of the node at the current end of the multi-selection (null when no selection)
syncEnabled  — boolean; whether cloud sync is active (persisted in localStorage as 'sync_enabled')
devMode      — boolean; whether the dev panel is visible (persisted in localStorage as 'dev_mode')
```

---

## URL scheme

The zoom path is stored in the URL hash so the view survives a refresh and is bookmarkable.

```
#                         → root view
#/nodeId                  → zoomed into one level
#/nodeId/childId/...      → deeper zoom
```

Use `history.pushState` for zoom changes so back/forward work naturally. Use `history.replaceState` for everything else (e.g. minor state sync) to avoid polluting history.

---

## HTML structure

```html
<div id="search-bar">          <!-- fixed top, hidden unless .visible -->
  <input id="search-input">
  <span id="search-count">
  <button id="search-close">
</div>

<div id="app">
  <div id="breadcrumb">        <!-- sticky, crumb links + separators, hidden unless .visible -->
  <div id="zoom-title">        <!-- contenteditable, hidden at root -->
  <div id="zoom-desc">         <!-- contenteditable, hidden at root -->
  <div id="bullets">           <!-- main tree, rebuilt on every render -->
  <div id="empty-hint">        <!-- shown when current zoom has no children; click adds first bullet -->
</div>

<div id="toolbar">             <!-- fixed bottom -->
  <button id="btn-markdown">Markdown</button>    <!-- opens unified edit-as-markdown modal -->
  <span id="sync-indicator">                     <!-- sync status label (hidden when sync is off or not signed in) -->
  <button id="btn-options">Options</button>       <!-- opens options modal (theme, sign in, GitHub link) -->
  <span class="toolbar-hint">? for shortcuts</span>   <!-- click opens shortcuts modal -->
</div>

<div id="dev-panel">           <!-- fixed right sidebar, hidden unless dev mode is on -->
  <h3>Dev panel</h3>
  <div id="dev-panel-content"> <!-- populated by renderDevPanel(); updated on every render() and setSyncStatus() call -->
</div>

<!-- five modals, each a .modal-overlay.hidden wrapper -->
<div id="modal-login">     <!-- sign-in form: email + password fields, error message, Submit/Cancel buttons -->
<div id="modal-markdown">  <!-- editable textarea showing current outline as Markdown; Apply button imports changes -->
<div id="modal-shortcuts">
<div id="modal-options">   <!-- options: account (sign in / sign out / delete account), cloud sync toggle, developer mode toggle, theme toggle, GitHub repo link -->
<div id="modal-conflict">  <!-- conflict resolution: local vs server Markdown diff + resolved textarea; Keep Local / Use Server / Apply Resolved buttons -->
```

### Bullet row DOM (produced by `buildRow`)

```
.bullet-row  [data-id="{id}"]  style="margin-left: {depth*20}px"
  .bullet-gutter               fixed 36px wide, vertically centred
    .collapse-toggle           14px, opacity:0, active class if has children
    .bullet-dot                22px, click = zoomInto
  .bullet-content
    .bullet-text               contenteditable div
    .bullet-desc-view          div, display:none unless .visible; shows truncated description (2 lines with CSS line-clamp)
    .bullet-desc               textarea, display:none unless .editing; shown while actively editing the description
```

---

## CSS architecture

Use CSS custom properties on `:root` for the entire palette and spacing:

```css
--bg, --surface, --border, --border-light
--text, --text-muted, --text-faint
--accent, --accent-light
--bullet
--hover, --selected
--danger
--font: Helvetica, Arial, sans-serif
--font-mono: "Courier New", Courier, monospace
--indent: 24px          /* defined in CSS but NOT used for row indentation; row margin-left is computed in JS as depth * 20px */
--radius: 4px
--toolbar-h: 42px
--search-h: 48px
--transition: 120ms ease
```

Dark mode is applied by setting `data-theme="dark"` on `<html>`. The `html[data-theme='dark']` selector overrides all colour custom properties with dark equivalents. The current theme is persisted in `localStorage` under the key `theme`. `applyTheme(theme)` sets the attribute and updates the toggle button label.

The sync indicator (`#sync-indicator`) uses modifier classes on the element itself: `syncing`, `synced`, `pending`, `error`, `conflict`. When none of these classes are present (or the `visible` class is absent) it is hidden. The `.sync-spinner` element uses a `@keyframes sync-spin` CSS animation for the rotating ring.

The dev panel (`#dev-panel`) is `position:fixed; right:0; top:0; bottom:0; width:320px` and is hidden (`.hidden` class) unless developer mode is active. `.btn-danger` follows the same structure as `.btn-primary` but uses `var(--danger)` as its background/border colour.

Key layout rules:

- `.bullet-row` — `display:flex; align-items:flex-start`. Depth applied as `style.marginLeft = depth * 20 + 'px'` in JS, not via the `--indent` CSS variable.
- `.bullet-gutter` — fixed `width:36px; height:28px; align-items:center`. Never changes with depth.
- `.bullet-dot` and `.collapse-toggle` — both `height:28px` to match gutter.
- `.bullet-content` — `flex:1; padding:5px 8px 5px 2px`. Text starts right after gutter. Font size scales by depth: depth 0 = 100%, depth 1 = 95%, depth 2+ = 90%.
- `.bullet-text` — `font-size:15px; line-height:1.6`.
- `.bullet-desc-view` — `font-size:0.867rem`, `line-height:1.25rem`, `color:var(--text-muted)`, `display:none` by default, `display:-webkit-box` with `-webkit-line-clamp:2` when `.visible` class present (truncates to 2 lines with "…"). Click to switch into edit mode.
- `.bullet-desc` — `font-size:0.867rem`, `line-height:1.25rem`, `color:var(--text-muted)`, `display:none` by default, `display:block` when `.editing` class present (textarea used while editing the description).
- Indent guide line — `::before` on `.bullet-row` at `left:22px`, `display:var(--has-children, none)`.
- `.collapse-toggle` — `opacity:0`; revealed via `.bullet-row:hover .collapse-toggle.active`.

Input and textarea `font-size` must be `16px` to prevent iOS zoom (override `.bullet-desc` for its smaller display size only after content is committed, or accept 16px there too).

---

## Inline markdown renderer

Hand-rolled, order matters:

```js
function renderInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
```

Applied only on blur. While editing, raw text is shown.

---

## Keyboard handling

`handleBulletKey(e, node)` is attached to `.bullet-text keydown`. Check shortcuts in this priority order:

| Priority | Action           | Default key        | Notes |
|----------|------------------|--------------------|-------|
| 0        | `unfocus`        | `Escape`           | Blur bullet; clears multi-selection |
| 0b       | `selectUp`       | `Shift+↑`          | Extend multi-selection upward |
| 0c       | `selectDown`     | `Shift+↓`          | Extend multi-selection downward |
| 1        | `toggleDesc`     | `Shift+Enter`      | Show/focus desc; from desc, return to text |
| 2        | `collapse`       | `Ctrl+Space`       | toggle collapsed/expanded node |
| 3        | `zoomIn`         | `Alt+→`            | zoom into node   |
| 4        | `zoomOut`        | `Alt+←`            | zoom out of node |
| 5        | `moveUp`         | `Alt+↑`            | move node (or entire selection) up   |
| 6        | `moveDown`       | `Alt+↓`            | move node (or entire selection) down |
| 7        | `indent`         | `Tab`              | indent node (or all selected nodes)    |
| 8        | `unindent`       | `Shift+Tab`        | unindent node (or all selected nodes)  |
| 9        | `newBullet`      | `Enter`            | Create new bullet |
| 10       | `deleteNode`     | `Ctrl+Backspace`   | Delete node (any content); confirmation if node has children |
| 11       | `deleteEmpty`    | `Backspace`        | Only on empty bullet (text and description both empty); confirmation if has children |
| 12       | `focusPrev`      | `ArrowUp`          | focus previous visible node; clears selection |
| 13       | `focusNext`      | `ArrowDown`        | focus next visible node; clears selection |
| 14       | `shortcuts`      | `?`                | show shortcuts (only when bullet text is empty) |
| 15       | `search`         | `Ctrl+F`           | focus search input |
| 16       | `undo`           | `Ctrl+Z`           | undo last structural change |

A global `keydown` listener handles `Escape` to close any open modal or the search bar, and handles `Ctrl+F` / `?` / `Ctrl+Z` when no editable element is focused. It also handles `ArrowDown` (focus first visible node) and `ArrowUp` (focus last visible node) when no item is focused.

## Touch / mobile handling

Each `.bullet-row` has `touchstart` / `touchend` listeners for swipe-to-indent:

- **Swipe right** (horizontal delta > 50 px, horizontal > 2× vertical) → `indentNode` (same as `Tab`).
- **Swipe left** (horizontal delta < −50 px, horizontal > 2× vertical) → `unindentNode` (same as `Shift+Tab`).

Both listeners are registered as `{ passive: true }` so they do not block scrolling.

---

## Description behaviour

- `.bullet-desc-view` is a `<div>` shown when `node.description` is non-empty; it uses CSS `-webkit-line-clamp: 2` to show at most 2 lines with "…" overflow. Click on it to start editing.
- `.bullet-desc` is a `<textarea>` shown (`.editing`) while the user is actively editing the description; hidden otherwise.
- `Shift+Enter` from `.bullet-text` → show textarea (`.editing`), hide view, focus textarea, cursor to end.
- `Shift+Enter` or `Escape` from textarea → blur textarea, refocus `.bullet-text`. The view div is then shown if `node.description` is non-empty.
- On textarea blur: if `node.description` is empty, both view and textarea are hidden.
- Auto-resize on input: `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'`.
- Description font is always smaller than bullet text (0.867rem), with a line-height of 1.25rem.
- When zoomed into a node, `#zoom-desc` is a `contenteditable` div. `Shift+Enter` or `Escape` from `#zoom-desc` returns focus to `#zoom-title`.

---

## Zoom behaviour

- `#zoom-title` and `#zoom-desc` are `contenteditable` divs, hidden at root zoom level. Both are editable while zoomed in; changes are saved on blur and the breadcrumb is re-rendered.
- On `zoomInto()`: after render, `requestAnimationFrame` → focus on first child, or create an empty one if none exists.
- `Alt+←` from any top child node → `zoomOut()`.
- `Escape` from `#zoom-title` also triggers `zoomOut()`.

---

## Import / Export

A single **Markdown** toolbar button opens the unified `#modal-markdown` modal.

The modal textarea is pre-populated with the current outline in Markdown format (same as the old export). The user can freely edit the Markdown text, then click **Apply** to replace the entire document with the parsed Markdown (same parser as the old import). Clicking **Cancel** discards any edits. The zoom stack is reset on Apply.

**Markdown format:**

```
- Bullet text
  > description line
  - Child bullet
+ Collapsed bullet
  - Hidden child
```

Recursive, depth increases indent by two spaces per level. Lines matching `/^(\s*)([-*+])\s(.*)$/` are bullets. Indent depth determines parent via a stack. Lines matching `/^\s*>\s(.*)$/` append to the last node's description.

The bullet character encodes collapsed/expanded state:
- `-` (or `*`) → expanded (children visible)
- `+` → collapsed (children hidden)

---

## Undo

`undoStack` is an in-memory array of serialised doc snapshots (max 100 entries).

- `pushUndo()` is called **before** each mutation: `newBulletAfter`, `deleteNode`, `indentNode`, `unindentNode`, `moveNode`, collapse toggle, and Apply in the Markdown modal. It is also called on focus of `.bullet-text` and `.bullet-desc` so that text/description edits are undoable.
- `undo()` pops the latest snapshot, restores `doc`, saves to localStorage, validates `zoomStack`, and re-renders.
- `Ctrl+Z` triggers `undo()` from both the bullet keydown handler and the global keydown handler (when no element is focused).

---

## Authentication

Authentication is provided by [Supabase](https://supabase.com), loaded from the CDN.

- The `#auth-ui` container inside `#modal-options` is populated dynamically by `renderAuthUI(user)`.
- On load, `initAuth()` synchronously shows the **Sign in** button, then asynchronously fetches the active session and updates the UI.
- Clicking **Sign in** opens `#modal-login`, which supports two modes: **Sign in** and **Sign up**.
- The modal starts in Sign-in mode. A "Don't have an account? Sign up" link toggles to Sign-up mode, which shows an additional **Confirm password** field.
- In Sign-up mode, submitting the form calls `supabaseClient.auth.signUp({ email, password })`. On success, a "Check your email for a confirmation link." message is shown (Supabase sends a confirmation email by default; this can be disabled in the Supabase Auth settings).
- In Sign-in mode, submitting the form calls `supabaseClient.auth.signInWithPassword({ email, password })`. On success, `#modal-login` closes and the Account section shows the signed-in email and a **Sign out** button.
- If the Supabase CDN is unavailable, the **Sign in** button is still shown, and submitting the form shows an "Authentication service unavailable." error.
- No changes to the Supabase project are required to enable sign-up — email/password sign-up is enabled by default.
- After sign-in, if sync is enabled, `startSync()` is called which triggers an immediate `syncNow()` and starts a 15-second `setInterval`. After sign-out, `stopSync()` clears the interval and resets the sync indicator.
- A signed-in user also sees a **Delete account** button (styled with `.btn-danger`). Clicking it shows a confirmation dialog, then deletes the user's row from the `outlines` table and calls `supabaseClient.auth.signOut()`. Local sync-state keys (`sync_version`, `sync_base`) are also cleared.

---

## Search

- Fixed bar at top (`display:none` normally, `display:flex` when active via `.visible` class). When open, `#app` receives the `search-open` class to add top padding.
- `Ctrl+F` opens it and focuses the input.
- On input: walk the entire `doc.root` tree (not just current zoom), collect matching IDs, show count, focus first match. Matches on **both** `text` and `description` fields.
- `Enter` cycles through matches.
- `Escape` closes and clears, then focuses the last highlighted match.

---

## Seeded initial data

On first load (empty document), seed with six tip bullets (one of which has two children) to demonstrate nesting, zoom, descriptions, and other features. Every seed bullet includes a description so the description feature is immediately visible. This gives users an immediate working example without any setup.

The seed data is immediately persisted to `localStorage` (via `saveDocLocal()`) so the seeded state survives a refresh even if the user makes no edits. On subsequent loads `loadDoc()` finds the stored document and `seedDoc` is not called again.

The seed data in Markdown format:

```
- Press **Enter** to create a new bullet
  > A new bullet is inserted immediately after the current one at the same depth. The cursor moves to it automatically so you can start typing right away.
- Use **Tab** and **Shift+Tab** to indent and unindent
  > Tab makes the current bullet a child of the bullet above it. Shift+Tab promotes it one level up. On mobile, swipe right to indent and swipe left to unindent.
- Use **Alt+↑/↓** to move bullets up and down
  > Reorders siblings without changing their depth or children. Use Ctrl+Space to collapse or expand a bullet's children.
  - Alt+→ to zoom into any bullet
    > Zooming focuses the view on a single node and its subtree. The breadcrumb bar at the top shows your current path and lets you navigate back up.
  - Alt+← to zoom back out
    > Returns to the parent level. You can also press Escape while editing the zoom title, or click any crumb in the breadcrumb bar.
- Press **Shift+Enter** to add a description to any bullet
  > Descriptions appear below the bullet text in a smaller muted font. Press Shift+Enter or Escape from the description to return to the bullet text. Click the description preview to edit it again.
- Use `Ctrl+F` to search your entire outline
  > Search matches both bullet text and descriptions across the whole document, not just the current zoom level. Press Enter to cycle through matches, Escape to close.
- Use `Ctrl+Z` to undo and the **Markdown** button to export
  > Undo reverses the last structural change (create, delete, move, indent). The Markdown toolbar button opens a live editor showing your full outline — edit it directly and click Apply to import changes.
```

---

## Known edge cases to handle

- `indentNode` when `idx === 0` → no previous sibling, do nothing.
- `unindentNode` when parent is the current zoom root → do nothing.
- `unindentNode` moves the node to after its parent and all of the node's subsequent siblings are re-parented as children of the unindented node (so the visual order is preserved and no siblings are lost).
- `unindentNodes` (multi-select) does NOT adopt subsequent siblings — only the explicitly selected nodes are promoted.
- `deleteNode` when it is the only child → focus parent (or zoom title if parent is zoom root).
- `deleteNode` when node has children → show a `window.confirm()` dialog before proceeding.
- `zoomStack` IDs from hash that no longer exist in doc → filter them out on load (also after undo).
- Re-render must not steal focus from an actively-edited element — check `document.activeElement` before calling `focusNode`.
- `matchShortcut` for `Ctrl+Space`: `e.key === ' '` not `'Space'`.
- `renderZoomTitle` must guard against overwriting content while the element is focused.
- Backspace delete must check both `text === ''` and `description === ''` to avoid accidental deletion of nodes with only a description.
- Multi-select (`selectedIds`) is cleared on direct bullet click/focus (via `_keepSelection` flag), on regular ArrowUp/Down, and on Escape.
- `moveNodes` requires all selected nodes to share the same parent and be contiguous; if not, the operation is a no-op.
- `indentNodes` processes nodes top-to-bottom so successive siblings all pile into the same previous sibling in order.
- `_keepSelection` flag prevents the focus event from clearing the selection when `extendSelection` programmatically focuses the selection head.
- `saveDoc()` marks `pendingSync = true` and updates the sync indicator; `saveDocLocal()` is the internal variant used during sync operations that must not trigger another push.
- `tryAutoMerge` returns `null` if any node was edited differently in both local and server versions; only call it when `lastSyncedDocJson` is available (i.e. after the first successful sync).
- `zoomStack` must be re-validated against the restored doc after a pull or merge — use `zoomStack = zoomStack.filter(id => !!findNode(id))`.
- `CompressionStream` / `DecompressionStream` are available in Chrome 80+, Firefox 113+, Safari 16.4+. The decompressData fallback attempts plain base64-encoded JSON for robustness.
- `syncEnabled` must be checked both in `initAuth()` (on session restore) and in `onAuthStateChange` (on sign-in) before calling `startSync()`, so users who have not opted in never trigger a sync.
- The dev panel (`#dev-panel`) is refreshed on every `render()` call and every `setSyncStatus()` call when `devMode` is `true`. `countNodes(root)` is a simple recursive counter used by `renderDevPanel()`.
