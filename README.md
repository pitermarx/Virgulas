# Outline App — Implementation Plan

## Purpose & scope

A keyboard-first infinite outliner running entirely in the browser.
No server, no build step, single HTML file, data lives in the browser (localStorage).
Export/import via Markdown.

---

## Tech decisions

- **Single HTML file** — HTML + `<style>` + `<script type="module">`. Zero dependencies, zero build.
- **Vanilla JS** — no framework. Direct DOM manipulation via a thin render layer.
- **Markdown** — a small hand-rolled inline parser (bold, italic, code, links). No external lib needed.

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
  <span class="toolbar-hint">? for shortcuts</span>   <!-- click opens shortcuts modal -->
</div>

<!-- two modals, each a .modal-overlay.hidden wrapper -->
<div id="modal-markdown">  <!-- editable textarea showing current outline as Markdown; Apply button imports changes -->
<div id="modal-shortcuts">
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

Key layout rules:

- `.bullet-row` — `display:flex; align-items:flex-start`. Depth applied as `style.marginLeft = depth * 20 + 'px'` in JS, not via the `--indent` CSS variable.
- `.bullet-gutter` — fixed `width:36px; height:28px; align-items:center`. Never changes with depth.
- `.bullet-dot` and `.collapse-toggle` — both `height:28px` to match gutter.
- `.bullet-content` — `flex:1; padding:5px 8px 5px 2px`. Text starts right after gutter. Font size scales by depth: depth 0 = 100%, depth 1 = 95%, depth 2+ = 90%.
- `.bullet-text` — `font-size:15px; line-height:1.6`.
- `.bullet-desc-view` — `font-size:0.867em`, `color:var(--text-muted)`, `display:none` by default, `display:-webkit-box` with `-webkit-line-clamp:2` when `.visible` class present (truncates to 2 lines with "…"). Click to switch into edit mode.
- `.bullet-desc` — `font-size:0.867em`, `color:var(--text-muted)`, `display:none` by default, `display:block` when `.editing` class present (textarea used while editing the description).
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

| Priority | Action        | Default key        | Notes |
|----------|---------------|--------------------|-------|
| 1        | `toggleDesc`  | `Shift+Enter`      | Show/focus desc; from desc, return to text |
| 2        | `collapse`    | `Ctrl+Space`       | toggle collapsed/expanded node |
| 3        | `zoomIn`      | `Alt+→`            | zoom into node   |
| 4        | `zoomOut`     | `Alt+←`            | zoom out of node |
| 5        | `moveUp`      | `Alt+↑`            | move node up   |
| 6        | `moveDown`    | `Alt+↓`            | move node down |
| 7        | `indent`      | `Tab`              | indent Node    |
| 8        | `unindent`    | `Shift+Tab`        | unindent Node  |
| 9        | `newBullet`   | `Enter`            | Create new bullet |
| 10       | `deleteNode`  | `Ctrl+Backspace`   | Delete node (any content); confirmation if node has children |
| 11       | `deleteEmpty` | `Backspace`        | Only on empty bullet (text and description both empty); confirmation if has children |
| 12       | `focusPrev`   | `ArrowUp`          | focus previous visible node |
| 13       | `focusNext`   | `ArrowDown`        | focus next visible node |
| 14       | `shortcuts`   | `?`                | show shortcuts (only when bullet text is empty) |
| 15       | `search`      | `Ctrl+F`           | focus search input |
| 16       | `undo`        | `Ctrl+Z`           | undo last structural change |

A global `keydown` listener handles `Escape` to close any open modal or the search bar, and handles `Ctrl+F` / `?` / `Ctrl+Z` when no editable element is focused. It also handles `ArrowDown` (focus first visible node) and `ArrowUp` (focus last visible node) when no item is focused.

---

## Description behaviour

- `.bullet-desc-view` is a `<div>` shown when `node.description` is non-empty; it uses CSS `-webkit-line-clamp: 2` to show at most 2 lines with "…" overflow. Click on it to start editing.
- `.bullet-desc` is a `<textarea>` shown (`.editing`) while the user is actively editing the description; hidden otherwise.
- `Shift+Enter` from `.bullet-text` → show textarea (`.editing`), hide view, focus textarea, cursor to end.
- `Shift+Enter` or `Escape` from textarea → blur textarea, refocus `.bullet-text`. The view div is then shown if `node.description` is non-empty.
- On textarea blur: if `node.description` is empty, both view and textarea are hidden.
- Auto-resize on input: `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'`.
- Description font is always smaller than bullet text (0.867rem), with a line-height of 1.25rem.

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
```

Recursive, depth increases indent by two spaces per level. Lines matching `/^(\s*)([-*])\s(.*)$/` are bullets. Indent depth determines parent via a stack. Lines matching `/^\s*>\s(.*)$/` append to the last node's description.

---

## Undo

`undoStack` is an in-memory array of serialised doc snapshots (max 100 entries).

- `pushUndo()` is called **before** each mutation: `newBulletAfter`, `deleteNode`, `indentNode`, `unindentNode`, `moveNode`, collapse toggle, and Apply in the Markdown modal. It is also called on focus of `.bullet-text` and `.bullet-desc` so that text/description edits are undoable.
- `undo()` pops the latest snapshot, restores `doc`, saves to localStorage, validates `zoomStack`, and re-renders.
- `Ctrl+Z` triggers `undo()` from both the bullet keydown handler and the global keydown handler (when no element is focused).

---

## Search

- Fixed bar at top (`display:none` normally, `display:flex` when active via `.visible` class). When open, `#app` receives the `search-open` class to add top padding.
- `Ctrl+F` opens it and focuses the input.
- On input: walk the entire `doc.root` tree (not just current zoom), collect matching IDs, show count, focus first match. Matches on **both** `text` and `description` fields.
- `Enter` cycles through matches.
- `Escape` closes and clears, then focuses the last highlighted match.

---

## Seeded initial data

On first load (empty document), seed with a welcome node containing five tip bullets (one of which has two children) to demonstrate nesting. This gives users an immediate working example without any setup.

---

## Known edge cases to handle

- `indentNode` when `idx === 0` → no previous sibling, do nothing.
- `unindentNode` when parent is the current zoom root → do nothing.
- `deleteNode` when it is the only child → focus parent (or zoom title if parent is zoom root).
- `deleteNode` when node has children → show a `window.confirm()` dialog before proceeding.
- `zoomStack` IDs from hash that no longer exist in doc → filter them out on load (also after undo).
- Re-render must not steal focus from an actively-edited element — check `document.activeElement` before calling `focusNode`.
- `matchShortcut` for `Ctrl+Space`: `e.key === ' '` not `'Space'`.
- `renderZoomTitle` must guard against overwriting content while the element is focused.
- Backspace delete must check both `text === ''` and `description === ''` to avoid accidental deletion of nodes with only a description.
