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
  <button id="btn-import">Import</button>
  <button id="btn-export">Export</button>
  <span class="toolbar-hint">? for shortcuts</span>   <!-- click opens shortcuts modal -->
</div>

<!-- three modals, each a .modal-overlay.hidden wrapper -->
<div id="modal-import">
<div id="modal-export">        <!-- includes a Copy button that copies to clipboard -->
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
    .bullet-desc               textarea, display:none unless .visible
    .bullet-children           optional child wrapper div
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
- `.bullet-desc` — `font-size:12px` (smaller than text), `color:var(--text-muted)`, `display:none` by default, `display:block` when `.visible` class present.
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

| Priority | Action        | Default key  | Notes |
|----------|---------------|--------------|-------|
| 1        | `toggleDesc`  | `Ctrl+Enter` | Show/focus desc; from desc, return to text |
| 2        | `collapse`    | `Ctrl+Space` | toggle collapsed/expanded node |
| 3        | `zoomIn`      | `Alt+→`      | zoom into node   |
| 4        | `zoomOut`     | `Alt+←`      | zoom out of node |
| 5        | `moveUp`      | `Alt+↑`      | move node up   |
| 6        | `moveDown`    | `Alt+↓`      | move node down |
| 7        | `indent`      | `Tab`        | indent Node    |
| 8        | `unindent`    | `Shift+Tab`  | unindent Node  |
| 9        | `newBullet`   | `Enter`      | Create new bullet |
| 10       | `deleteNode`  | `Backspace`  | Only on empty bullet (text and description both empty) |
| 11       | `focusPrev`   | `ArrowUp`    | focus previous visible node |
| 12       | `focusNext`   | `ArrowDown`  | focus next visible node |
| 13       | `shortcuts`   | `?`          | show shortcuts (only when bullet text is empty) |
| 14       | `search`      | `Ctrl+F`     | focus search input |

A global `keydown` listener handles `Escape` to close any open modal or the search bar, and handles `Ctrl+F` / `?` when no editable element is focused.

---

## Description behaviour

- `.bullet-desc` is a `<textarea>`, hidden by default.
- `Ctrl+Enter` from `.bullet-text` → add `.visible`, focus textarea, cursor to end.
- `Ctrl+Enter` or `Escape` from textarea → blur textarea, focus `.bullet-text`.
- On textarea blur: if `node.description` is empty, remove `.visible`.
- Auto-resize on input: `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'`.
- Description font is always smaller than bullet

---

## Zoom behaviour

- `#zoom-title` and `#zoom-desc` are `contenteditable` divs, hidden at root zoom level. Both are editable while zoomed in; changes are saved on blur and the breadcrumb is re-rendered.
- On `zoomInto()`: after render, `requestAnimationFrame` → focus on first child, or create an empty one if none exists.
- `Alt+←` from any top child node → `zoomOut()`.
- `Escape` from `#zoom-title` also triggers `zoomOut()`.

---

## Import / Export

**Export to Markdown:**

```
- Bullet text
  > description line
  - Child bullet
```

Recursive, depth increases indent by two spaces per level. The export modal includes a **Copy** button that copies the Markdown to the clipboard and briefly changes its label to "Copied!".

**Import from Markdown:** parse line by line. Lines matching `/^(\s*)([-*])\s(.*)$/` are bullets. Indent depth determines parent via a stack. Lines matching `/^\s*>\s(.*)$/` append to the last node's description. Importing replaces the entire document and resets the zoom stack.

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
- `zoomStack` IDs from hash that no longer exist in doc → filter them out on load.
- Re-render must not steal focus from an actively-edited element — check `document.activeElement` before calling `focusNode`.
- `matchShortcut` for `Ctrl+Space`: `e.key === ' '` not `'Space'`.
- `renderZoomTitle` must guard against overwriting content while the element is focused.
- Backspace delete must check both `text === ''` and `description === ''` to avoid accidental deletion of nodes with only a description.
