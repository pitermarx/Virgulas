# Virgulas

Virgulas is a local-first browser outliner.

## Features

- Infinite list of editable nodes with recursive children
- Markdown rendering (bold, italic, links, images, inline code); markdown links always open in a new tab/window
- Inline `#tags` and `@mentions` are highlighted and clickable; tapping/clicking one opens Search with that token
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
- Search: substring match, `Tab`/`Shift+Tab` or `↑`/`↓` cycles results, pressing `Enter` or clicking a result zooms to the match; current result highlighted distinctly; mobile includes a status-bar Search button
- Developer panel (`Ctrl+Alt+D` toggles at runtime): outline stats, sync diagnostics, crypto timings, storage quota, focused node raw JSON
- Node typography hierarchy (root 1rem, level 2 0.9rem, level 3+ 0.85rem)
- Distinct focus style (accent background + left border) separate from hover style
- Theme toggle (light/dark) persisted in localStorage
- Bottom-sheet lock screen flow with quick local unlock/setup and advanced mode switching:
  - **Local** 🔒 — passphrase-only create/unlock; data encrypted in localStorage; new document starts with one empty node
  - **Remote** 🔒 — account email + password + encryption passphrase; encrypted cloud sync via Supabase
  - **Filesystem** 📄 — open/create a local `.vmd` file via File System Access API; no encryption, no passphrase; new empty file gets one initial node
  - In quick local mode, **Advanced Storage Options** (or **Switch Mode**) reveals the Local/Remote/File selector and full auth form
- **Memory mode** (first-ever visit): on the very first visit the app skips the lock screen entirely
  - The document lives only in JS memory and is lost when the tab is closed or reloaded
  - A built-in intro document (`intro.vmd`) is loaded automatically to walk new users through every feature; if the fetch fails an empty node is provided
  - An inline **Enable Secure Storage** prompt appears above the outline and opens the bottom-sheet setup flow
  - The status bar shows an *In memory — not saved* badge
  - Raw mode is hidden (no document to save)
  - **Options → Upgrade storage…** lets the user switch to a persistent mode at any time (data loss warning shown)
  - Once the user unlocks any persistent mode, that choice is remembered and shown as the default on the next visit
  - The lock screen shows a **"Skip — continue in memory"** link that bypasses unlock for the current session; the remembered mode is preserved so the next visit still shows the lock screen
  - When the app is locked, the main canvas remains visible in a blurred state using `intro.vmd` as background context until unlock
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
  `npm install` also syncs browser runtime dependencies into `source/vendor/` (no bundler/build step required).

2.  Run locally (serves the `source/` folder):
    ```bash
    npm run serve
    ```

  Offline support notes:
  - Runtime dependencies are self-hosted from `source/vendor/` (no CDN dependency at runtime)
  - A service worker (`source/sw.js`) caches assets in three separate buckets so the app works offline after the first successful load:
    - **Vendor cache** — `source/vendor/` JS files; served **cache-first**
    - **Fonts & icons cache** — `source/fonts/` and `source/media/` files; served **cache-first**
    - **App cache** — HTML, CSS, and `source/js/` modules; served **stale-while-revalidate**
  - Cache version constants in `sw.js` are bumped automatically by `scripts/bump-sw-caches.mjs`, which hashes each file group and increments only the versions whose files have changed
  - `npm install` runs the bump script automatically, so vendor cache bumps after dependency updates require no manual work
  - For font/icon/app file changes, run `npm run sw:bump` before committing, or install Git hooks (`npm run sw:hooks`) to run `sw:bump` on push and validate Conventional Commit headers on commit

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
- Main branch CI validates commit policy, computes semantic version bumps from Conventional Commits, and publishes a GitHub release tag when releasable commits exist.
- Main branch CI publishes the latest database migrations to the linked Supabase project before deploy.
- Main branch deploys the static site to GitHub Pages, stamps the resolved app version into `index.html`, writes `version.json`, and publishes branch previews under `/preview/<branch>`.
- A daily workflow runs E2E tests against `https://virgulas.com`.

Repository secrets expected by workflows:

- `SUPABASE_PROJECT` (project ref; used for DB migration publish)
- `SUPABASE_ACCESS_TOKEN` (for CI migration publish)
- `CLOUDFLARE_ZONE_ID` (optional, for cache purge)
- `CLOUDFLARE_API_TOKEN` (optional, for cache purge)

## Commit Message Policy

All commits in this repository (human and AI-authored) must follow Conventional Commits:

```text
type(scope)!: subject
```

Allowed types:

- `feat`
- `fix`
- `docs`
- `style`
- `refactor`
- `perf`
- `test`
- `build`
- `ci`
- `chore`
- `revert`

Examples:

- `feat(sync): add pull-before-push retries`
- `fix(ui)!: rename storage mode labels`
- `chore: bump sw cache versions`

Enforcement:

- Local `commit-msg` hook validates the commit header (installed by `npm run sw:hooks`)
- CI validates every commit in the PR/push range and fails on non-conforming headers

You can run checks manually:

```bash
npm run commit:check
npm run commit:check:range -- "HEAD~5..HEAD"
```

Release planning dry-run:

```bash
npm run release:plan
```
