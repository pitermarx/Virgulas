# Virgulas

Virgulas is a local-first outliner that stays fast, keyboard-friendly, and easy to reshape. It runs directly in the browser, saves your work locally by default, and can sync encrypted data to Supabase when you sign in.

![Virgulas main view](source/screenshots/main.png)

## What it does

- Create, reorder, indent, and zoom through nested bullets quickly.
- Add descriptions to any bullet without leaving the outline.
- Search across both bullet titles and descriptions.
- Import and export the whole outline as Markdown.
- Render inline Markdown for bold, italic, code, links, and images.
- Work fully offline when signed out.
- Sync encrypted data across devices when signed in.

## How it feels to use

Virgulas is built around one continuously editable outline.

- The main list shows the current level of the outline.
- Clicking a bullet dot zooms into that bullet.
- The breadcrumb bar shows where you are and lets you jump back up.
- The zoom description area lets you keep notes about the current zoomed section.
- The ghost row at the bottom is always ready for a new item.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| New bullet | `Enter` |
| Delete bullet | `Ctrl+Backspace` |
| Indent | `Tab` |
| Unindent | `Shift+Tab` |
| Move bullet up | `Alt+ArrowUp` |
| Move bullet down | `Alt+ArrowDown` |
| Zoom in | `Alt+ArrowRight` |
| Zoom out | `Alt+ArrowLeft` |
| Open description editor | `Shift+Enter` |
| Collapse or expand children | `Ctrl+Space` |
| Undo last structural change | `Ctrl+Z` |
| Search | `Ctrl+F` |
| Open shortcuts | `?` |
| Focus previous bullet | `ArrowUp` |
| Focus next bullet | `ArrowDown` |
| Extend selection up | `Shift+ArrowUp` |
| Extend selection down | `Shift+ArrowDown` |
| Copy multi-selection as Markdown | `Ctrl+C` |
| Unfocus bullet or close the top layer | `Escape` |

Notes:

- `Ctrl+C` only copies when multiple bullets are selected.
- In the description editor, `Shift+Enter` and `Escape` return focus to the bullet text.
- When nothing is being edited, `Enter` focuses the new-item row.

## Search

Search is global for the current document, not just the current zoom level.

- It matches bullet text.
- It matches bullet descriptions.
- `Enter` in the search box jumps to the next result.
- `Escape` closes search and returns focus to the current match when possible.

## Markdown import and export

The `Markdown` button opens a live editor for the current document.

- Click `Markdown` to export the outline.
- Edit the text directly and click `Apply` to import it back.
- Indentation uses two spaces per level.
- Bullet lines use `-`, `*`, or `+` on import.
- Export uses `-` for expanded bullets and `+` for collapsed bullets.
- Description lines are written as indented `>` lines under a bullet.

Example:

```md
- Project
  > Short summary
  - Next step
  + Collapsed branch
```

Inline Markdown inside bullet text is rendered on blur:

- `**bold**`
- `*italic*`
- `` `code` ``
- `[link](https://example.com)`
- `![image alt](https://example.com/image.png)`

## Accounts and sync

You do not need an account to use Virgulas.

- Signed out: the app stores the outline locally in the browser.
- Signed in: the app encrypts the outline in the browser and syncs it to Supabase.
- Signing in can replace local data with the server version, so the app asks for confirmation first when local bullets already exist.
- If both local and remote versions changed in incompatible ways, Virgulas opens a conflict modal so you can keep local, use server, or edit a resolved version.

### Toolbar indicators

The toolbar includes two small status indicators.

- Storage indicator: shown only while signed in. It displays the encrypted payload size against a 20 KB budget and shows the exact value in a tooltip.
- Sync indicator: shows whether sync is online, pending, syncing, synced, in error, or blocked by a conflict.

## Interface

The main UI includes:

- Search bar
- Breadcrumb bar
- Zoom description field
- Bullet list
- Ghost row for new items
- Toolbar with `Markdown`, storage indicator, sync indicator, `Options`, and shortcuts
- Options modal
- Login modal
- Shortcuts modal
- Markdown modal
- Conflict modal
- Dev panel

Inside `Options` you can:

- Sign in or sign out
- Delete your account
- Toggle developer mode
- Switch between light and dark themes
- Open the GitHub repository

## Run locally

Virgulas has no build step.

```bash
npm install
npx serve source
```

Then open `http://localhost:3000`.

## Tests

```bash
npm test
npm run test:headed
npm run test:ci
```

Playwright serves the `source/` directory on port 3000 during test runs.

## Project layout

```text
source/
  index.html
  style.css
  js/
  vendor/
test/
supabase/
```

The app itself lives in `source/`, Playwright coverage lives in `test/`, and Supabase schema files live in `supabase/`.
