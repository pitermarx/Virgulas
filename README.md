# Virgulas

Virgulas is a local-first browser outliner.

## Features

- Infinite list of editable nodes with recursive children
- Markdown rendering (bold, italic, links, images, inline code)
- Optional description field per node (auto-growing textarea when editing)
- Node collapse/expand (button click or `Ctrl+Space`)
- Node indent/unindent (`Tab` / `Shift+Tab`)
- Node move (`Alt+↑` / `Alt+↓`)
- Node delete (`Ctrl+Backspace` or `Backspace` on empty node)
- Zoom into a node (`Alt+→`) with breadcrumb navigation
  - Zoomed node description is visible and editable with placeholder when empty
  - Zoomed node with no children shows an empty state to create the first child
- Undo/Redo stack (`Ctrl+Z` / `Ctrl+Y`)
- Smart-case search with result counter and `Tab`/`Shift+Tab` cycling
  - `Escape` clears search; `Enter` zooms to the closest collapsed ancestor of the current result
- Raw mode editor (`.vmd` format) with SAVE/CANCEL
- Node typography hierarchy (root 1rem, level 2 0.9rem, level 3+ 0.85rem)
- Distinct focus style (accent background + left border) separate from hover style
- Theme toggle (light/dark) persisted in localStorage
- Client-side AES-GCM encryption (passphrase never stored or transmitted)
- Optional quick unlock with device passkey (WebAuthn PRF) after passphrase unlock
  - Optimistic capability detection with automatic local disable after failed PRF registration/unlock
  - Reset quick unlock keys from Unlock screen or Options -> Data
- Account controls in Options modal (sign up, sign in, sign out)
- Optional cloud sync via Supabase (end-to-end encrypted)
- Keyboard shortcuts modal (`?` button)
- Options panel (theme, source link, reset quick unlock keys, purge data)

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
