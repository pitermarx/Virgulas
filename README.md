# Virgulas

Virgulas is a local-first browser outliner.

## Features

- Infinite list of editable nodes with recursive children
- Markdown rendering (bold, italic, links, images, inline code)
- Optional description field per node (auto-growing textarea when editing)
- Node collapse/expand (button click or `Ctrl+Space`)
- Multi-select with `Shift+↑/↓`; `Delete`, `Tab`/`Shift+Tab`, `Ctrl+Space` all work on selection
- Node indent/unindent (`Tab` / `Shift+Tab`), plus mobile swipe right/left to indent/outdent; swipe does not change focus
- Node move (`Alt+↑` / `Alt+↓`)
- Node delete (`Ctrl+Backspace` or `Backspace` on empty node); `Backspace` on non-empty node deletes the character (normal text editor behaviour)
- Zoom into a node (`Alt+→`) with breadcrumb navigation
  - Zoomed node description is visible and editable with placeholder when empty
  - Zoomed node with no children shows an empty state to create the first child
  - Empty root document shows an empty state to create the first node
- Raw mode editor (`.vmd` format) with Save / Cancel; invalid VMD saves are rejected with an inline error and no data loss
- Search: substring match, `Tab`/`Shift+Tab` or `↑`/`↓` cycles results, pressing `Enter` or clicking a result zooms to the match; current result highlighted distinctly
- Debug panel (visible with `?debug=true`, shows internal state)
- Node typography hierarchy (root 1rem, level 2 0.9rem, level 3+ 0.85rem)
- Distinct focus style (accent background + left border) separate from hover style
- Theme toggle (light/dark) persisted in localStorage
- Three storage modes selectable on the lock screen:
  - **Local** 🔒 — passphrase-only create/unlock; data encrypted in localStorage; new document starts with one empty node
  - **Remote** 🔒 — account email + password + encryption passphrase; encrypted cloud sync via Supabase
  - **Filesystem** 📄 — open/create a local `.vmd` file via File System Access API; no encryption, no passphrase; new empty file gets one initial node
- **Memory mode** (first-ever visit): on the very first visit the app skips the lock screen entirely
  - The document lives only in JS memory and is lost when the tab is closed or reloaded
  - A built-in intro document (`intro.vmd`) is loaded automatically to walk new users through every feature; if the fetch fails an empty node is provided
  - The status bar shows an *In memory — not saved* badge
  - Raw mode is hidden (no document to save)
  - **Options → Upgrade storage…** lets the user switch to a persistent mode at any time (data loss warning shown)
  - Once the user unlocks any persistent mode, that choice is remembered and shown as the default on the next visit
  - The lock screen shows a **"Skip — continue in memory"** link that bypasses unlock for the current session; the remembered mode is preserved so the next visit still shows the lock screen
- Status toolbar shows the current storage mode; in Remote mode it also shows the signed-in email/username
- Lock screen clearly labels encryption status per mode; Remote mode has separate Sign in / Create account tabs
- Destructive mode switches (clearing local data, signing out) require confirmation
- Optional cloud sync via Supabase (end-to-end encrypted)
  - Pull-before-push: before every write, the remote `updated_at` timestamp is checked; if the remote is newer the doc is fetched and merged before uploading
  - Per-node `lastModified` timestamps drive node-level merge: one-side-only changes are applied silently; same-node different-field changes are also auto-merged
  - Conflict resolution when the same field is edited on both sides: a blocking modal shows each conflict side-by-side with "Keep local" / "Keep remote" per field and "Use all local" / "Use all remote" bulk buttons; "Apply" is disabled until every conflict is resolved
  - 60-second background polling checks for remote updates while the app is open; pauses when conflicts are pending
- Keyboard shortcuts modal (`?` button) — desktop only (hidden on mobile)
- Options modal: theme toggle, source link, mode-specific session action (Sign out / Lock / Change file), purge data
- `Enter` on a collapsed node with children creates a sibling, not a child

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Run locally (serves the `source/` folder):
    ```bash
    npm run serve
    ```

  The app reads Supabase settings from `localStorage.supabaseconfig` and seeds it automatically on first run with hosted defaults:
  - `url`: `https://gcpdascpdrakecpknrtt.supabase.co`
  - `key`: `sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc`

  To point the browser to local Supabase, set `localStorage.supabaseconfig` to a JSON object with `url` and `key`.

3.  Run tests:
  ```bash
  npm test
  ```
  `npm test` runs both suites in sequence (always executes both; exits non-zero if either fails):
  - E2E Playwright specs (`npm run test:e2e`)
  - Browser unit harness via `source/test.html` (`npm run test:unit`)

## Supabase Workflows

All Supabase commands in this repository use the locally pinned CLI (`supabase` devDependency) via npm scripts or `npm exec`.

### Local (development)

1. Initialize local Supabase files (first time only):
  ```bash
  npm run db:init
  ```

2. Start local Supabase manually:
  ```bash
  npm run db:start
  ```

3. Serve the app:
  ```bash
  npm run serve
  ```

4. Stop local Supabase when finished:
  ```bash
  npm run db:stop
  ```

5. Get local API URL and anon key from CLI output:
  ```bash
  npm exec supabase -- status
  ```

6. Reset local DB to migrations only:
  ```bash
  npm run db:reset
  ```

Playwright local tests assume local Supabase is already running and `.env` exists (created by `npm run db:start`).
The test fixture overrides `localStorage.supabaseconfig` from `.env` before each page load.

Available test commands:

```bash
npm run test:e2e   # Playwright feature/E2E specs only
npm run test:unit  # Browser unit harness spec only
npm test           # Runs e2e, then unit harness
```

Auth tests that require a specific account attempt sign-in first and create the user only when it does not exist.

### Schema and migration workflow

1. Edit schema files in `supabase/schemas/*.sql`.
2. Generate a migration from schema diff:
  ```bash
  npm run db:migrate -- <migration-name>
  ```
3. Apply migrations locally and re-seed:
  ```bash
  npm run db:reset
  ```

### Production

1. Log in and link your hosted Supabase project:
  ```bash
  npm exec supabase -- login
  npm exec supabase -- link --project-ref <your-project-ref>
  ```

2. Apply local migrations to the linked project:
  ```bash
  npm exec supabase -- db push --linked
  ```

3. If needed, inspect migration plan before applying:
  ```bash
  npm exec supabase -- db push --linked --dry-run
  ```

4. To reset a linked remote database and apply only local migrations (no seed):
  ```bash
  npm exec supabase -- db reset --linked --no-seed --yes
  ```

## CI/CD

- Pull requests and pushes run Playwright E2E tests in GitHub Actions.
- Main branch CI publishes the latest database migrations to the linked Supabase project before deploy.
- Main branch deploys the static site to GitHub Pages and publishes branch previews under `/preview/<branch>`.
- A daily workflow runs E2E tests against `https://virgulas.com`.

Repository secrets expected by workflows:

- `SUPABASE_PROJECT` (project ref; used for DB migration publish)
- `SUPABASE_ACCESS_TOKEN` (for CI migration publish)
- `CLOUDFLARE_ZONE_ID` (optional, for cache purge)
- `CLOUDFLARE_API_TOKEN` (optional, for cache purge)
