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
- Account controls in Options modal (sign up, sign in, sign out)
- Optional cloud sync via Supabase (end-to-end encrypted)
- Keyboard shortcuts modal (`?` button)
- Options panel (theme, source link, purge data)

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Run locally (serves the `source/` folder):
    ```bash
    npm run serve
    ```

  For full local auth/sync development (auto-starts Supabase, injects local URL/key, and cleans up DB on exit):
  ```bash
  npm run local
  ```

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

2. Start the full local dev stack with automatic config injection:
  ```bash
  npm run local
  ```

  What `npm run local` does:
  - Starts local Supabase services
  - Reads local `Project URL` and `Publishable` key from `supabase status`
  - Backs up and patches `source/index.html` placeholders
  - Serves the app on port 3000
  - On exit, restores `source/index.html` and runs `supabase stop --no-backup --yes`

3. Optional manual Supabase control (without serving app):
  ```bash
  npm run db:start
  npm run db:stop
  ```

4. Get local API URL and anon key from CLI output:
  ```bash
  npm exec supabase -- status
  ```

5. Reset local DB to migrations + seed data:
  ```bash
  npm run db:reset
  ```

6. Seed test account credentials:

| Field      | Value                            |
|------------|----------------------------------|
| Email      | `test@virgulas.com`              |
| Password   | `testpassword`                   |
| Passphrase | `correct horse battery staple`   |

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

- `SUPABASE_PROJECT` (project ref; used for deploy config injection and DB publish)
- `SUPABASE_PUBLISHABLE_DEFAULT_KEY` (used for deploy config injection)
- `SUPABASE_ACCESS_TOKEN` (for CI migration publish)
- `CLOUDFLARE_ZONE_ID` (optional, for cache purge)
- `CLOUDFLARE_API_TOKEN` (optional, for cache purge)
