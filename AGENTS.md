# Agents

This document defines the rules every agent or contributor must follow, and everything needed
to run the app and tests locally. Read it completely before starting any task.

---

## Environment setup

### Prerequisites

- Bun 1.4 or later (runs TypeScript directly, the bundler, and the unit test runner)
- Node.js 20 or later (only needed to launch Playwright)
- A Supabase project (free tier is sufficient)

### Environment variables

For normal local development, `.env` is optional.

If you want to point tests or the app to a specific external environment, create a `.env` file in the project root (gitignored, never commit it):

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

The app reads Supabase settings from `localStorage.supabaseconfig`.
On first run, it seeds this key with hosted defaults:

```json
{
  "url": "https://gcpdascpdrakecpknrtt.supabase.co",
  "key": "sb_publishable_9Uxo-0GD-21K6mUPQ2FSuw_mDO06TJc"
}
```

To use local Supabase in the browser, set `localStorage.supabaseconfig` with your local URL/key.

### Running locally

The browser only ever loads the built bundle; it cannot run `source/js/*.ts` directly.

Build and serve locally (builds `dist/` then serves it):

```bash
bun run dev
```

### Bundling and dependencies

`bun run build` (`scripts/build-bun.mjs`) bundles `source/js/app.ts` and the
`source/css/*.css` modules into `dist/js/app.js` + `dist/js/app.css`, then stamps the
version into `dist/index.html` and `dist/version.json`.

- Runtime dependencies (`preact`, `@preact/signals`, `htm`, `marked`, `dompurify`,
  `@supabase/supabase-js`) are resolved from `node_modules` at build time.
- There is **no import map and no CDN dependency at runtime**.
- `scripts/serve-bun.mjs` is a Bun static server used for local dev and Playwright.
- Do not add a runtime CDN import; add dependencies to `package.json` and import them.
- **Code splitting:** `@supabase/supabase-js` (~220 KB minified) is imported **dynamically** in
  `sync.ts` and emitted as a separate `dist/js/chunk-*.js`. It is fetched only when Remote is the
  persisted mode (`persistence.getAuthBootstrap` gates the session probe on it), so local, memory
  and file users never download or parse it. Do not turn that import back into a static one — a
  top-level `import` puts it back on the critical path for everyone. The chunk name is
  content-hashed, so it is intentionally **not** listed in the service worker `APP_SHELL`; the
  SW's stale-while-revalidate handler caches it on first use.
- **Startup-path rule:** `getAuthBootstrap` must not probe IndexedDB or the network unless the
  persisted mode needs it. The File-mode handle lookup is gated on `filesystem` and the Supabase
  session probe on `remote`; both were previously unconditional and cost ~30 ms of time-to-reveal.
- Source maps: both `bun run dev` and `bun run build` emit a linked `dist/js/app.js.map`
  (with `sourcesContent`, so the pruned `.ts` files still resolve in DevTools). Pass
  `--no-sourcemap` for a lean release artifact, or `--sourcemap=inline|external|none` to
  change the mode; `--no-minify` produces a readable unminified bundle. Bun's bundler emits
  JS maps only — there is no CSS source map. Source maps are intentionally **not** in the
  service worker `APP_SHELL`, so they are never pre-cached.

### Service worker caches (`source/sw.js`)

The service worker uses two versioned caches. Each cache has a dedicated strategy.

| Cache constant  | Cache name pattern       | Covers                                           | Strategy               |
| --------------- | ------------------------ | ------------------------------------------------ | ---------------------- |
| `FONTS_CACHE`   | `virgulas-fonts-v<N>`    | `source/fonts/` and `source/media/` assets       | Cache-first            |
| `APP_CACHE`     | `virgulas-app-v<N>`      | built `js/app.js`, `js/app.css`, `index.html`    | Stale-while-revalidate |

**Version bumps are automated.** `scripts/bump-sw-caches.mjs` hashes each file group and increments the matching version constant in `sw.js` only when the files have changed. Hashes are stored in `scripts/.sw-cache-hashes.json` (committed).

- `bun install` runs the bump script automatically (via `postinstall`).
- For changes to fonts, media, or app files, run `bun run sw:bump` before committing.
- To automate this for every push and enforce commit format, install Git hooks once per clone:
  ```bash
  bun run sw:hooks
  ```
  Installed hooks:
  - `pre-push` runs `sw:bump` and aborts the push if `sw.js` was modified, prompting you to commit the version bump first.
  - `commit-msg` validates Conventional Commits headers.

**Adding a new file to a pre-cached shell:** add the path to the appropriate `*_SHELL` array in `source/sw.js`, add the same path (or its parent directory) to the matching group in `scripts/bump-sw-caches.mjs`, then run `bun run sw:bump`.

### Database setup

Initialize local Supabase files (first time only):

```bash
bunx supabase init
```

Start local Supabase:

```bash
bun run db:start
```

Playwright local tests assume `bun run db:start` has been run and `.env` exists.
Tests override `localStorage.supabaseconfig` from `.env` before every page load.

Get local URL and anon key for `.env`:

```bash
bunx supabase status
```

Generate a migration after editing `supabase/schemas/*.sql`:

```bash
bunx supabase migration new <migration-name>
```

Apply migrations locally (no seed):

```bash
bunx supabase db reset
```

Tests that require a signed-in state should first attempt sign-in and create the user if it does not exist.

Stop local Supabase:

```bash
bun run db:stop
```

### Production migrations

Link the hosted project and push migrations:

```bash
bunx supabase login
bunx supabase link --project-ref <your-project-ref>
bunx supabase db push --linked
```

Preview migration application without applying:

```bash
bunx supabase db push --linked --dry-run
```

### Running tests

```bash
bun run test                     # unit + e2e
bun run test:e2e                 # e2e specs only
bun run test:e2e -- tests/sync.spec.ts
bun run test:e2e -- --headed     # visible browser
bun run test:unit                # bun test (tests/unit)
```

`bun run test` always runs both suites and returns non-zero if either suite fails.

Playwright starts the app automatically via `bun run dev` (build + static server) — no separate server step needed.

- Local Playwright runs require local Supabase credentials (`.env` or `supabase status`) and fail fast if missing.
- Locally Playwright runs Chromium only. In CI (`CI=true`) it runs Chromium, Firefox, and WebKit.
- Unit tests run in-process under `bun test` with happy-dom (`tests/setup/dom.ts`, preloaded via `bunfig.toml`).
- `bun run typecheck` runs both TypeScript configs (app strict + tests strict) and must report 0 errors.

### CI/CD

Required repository secrets for CI:

- `SUPABASE_PROJECT` for main-branch migration publishing
- `SUPABASE_ACCESS_TOKEN` for main-branch migration publishing

Main-branch CI must always run migration publish before deploy:

```bash
bunx supabase link --project-ref "$SUPABASE_PROJECT"
bunx supabase db push --linked --include-all
```

Workflows install Bun (`oven-sh/setup-bun`) and run `bun install --frozen-lockfile`;
tests run with `bun run test`. The deploy job builds `dist/` and uploads it as the Pages artifact.

---

## Frontend module map (`source/js`)

Use this as the default responsibility split. Keep files focused and avoid mixing concerns.

- `app.ts`:
  App bootstrap, lock screen/auth flow, top-level render tree, modal orchestration.
- `ui.ts`:
  Preact UI components for the outliner surface and toolbars (`Outline`, node rendering, search results UI, tasks panel, debug panels).
- `search.ts`:
  Search UI state and pure search helpers shared by UI and keyboard handling (`searchQuery`, `searchResultIndex`, `currentSearchMatchId`, match flattening helpers).
- `shortcuts.ts`:
  Keyboard interaction and focus/navigation behaviour (including search key handling).
- `outline.ts`:
  Core document model and tree operations (CRUD, move/indent/outdent, serialization, VMD parser/writer, search tree generation).
- `persistence.ts`:
  Persistence orchestration for Local/Remote/File/Memory modes, unlock/sign-in flows, autosave wiring.
- `sync.ts`:
  Remote sync protocol logic (timestamp checks, merge/conflict resolution, background upload scheduling) and the Supabase client.
- `crypto2.ts`:
  Cryptographic primitives and key derivation (Web Crypto only).
- `markdown.ts`:
  Inline markdown rendering and sanitisation.
- `meta.ts`:
  `due:` / `rec:` metadata parsing and formatting.
- `tasks.ts`:
  Grouped task selectors (pending/scheduled/done) and breadcrumbs.
- `inbox.ts`:
  Quick-capture queue and Inbox node reconciliation.
- `biometrics.ts`:
  WebAuthn passkey enrolment and passphrase sealing.
- `utils.ts`:
  Tiny shared utilities, `appVersion`, and the `localStorage` store slots.
- `globals.d.ts`, `css.d.ts`:
  Ambient declarations for browser globals and CSS imports.

Unit test suites live in `tests/unit/suites/` (see Testing below).

### Naming and splitting rules

- Name files by responsibility
- If a module exceeds ~350-450 lines and mixes unrelated concerns, split it.
  Preferred split order:
  1. shared state/helpers into a focused module
  2. feature-specific logic into that feature module
  3. keep orchestration in the original module
- Avoid circular dependencies.
  If two modules need shared state, extract that state into a third module (as done with `search.ts`).

## Rules

### Rule 1 — Respect SPEC.vmd

`SPEC.vmd` is the source of truth. Do not change it unless specifically instructed.

- Features absent from `SPEC.vmd` must be removed
- Features present in `SPEC.vmd` must exist in the app
- If the SPEC is ambiguous or contradictory, **stop and ask** — do not assume
- If a task requires a SPEC change to implement correctly, **stop and ask**

### Rule 2 — Keep README.md in sync

`README.md` is the authoritative human-readable description of the app.
Whenever you add, remove, or change a feature, update `README.md` in the same commit.

### Rule 3 — Every feature must have tests

Whenever you add or change a feature or behaviour, add or update the corresponding test(s).

- Pure logic (document model, parsers, crypto, sync merge, markdown) → unit suite in `tests/unit/suites/*.ts`, run with `bun test`. Register the suite in `tests/unit/unit.test.ts`.
- UI behaviour and integration flows → Playwright spec in `tests/*.spec.ts`.
- E2E specs import app singletons from the built bundle (`/js/app.js`) so they observe the same module instances as the running app.
- A feature is not considered implemented until its tests pass
- Tests must cover the happy path and all edge cases described in `SPEC.vmd`
- Do not mark a task complete if any test is failing

### Rule 4 — Update schema files for any database schema change

Whenever you add, modify, or remove a table, column, index, policy, or function,
update the corresponding file in `supabase/schemas/` in the same commit.

- Schema files live in `supabase/schemas/` (e.g. `outlines.sql`)
- Migrations are auto-generated by Supabase from the schema diff — do not write them manually
- To apply and generate a migration after editing a schema file:
  ```bash
  bunx supabase migration new <migration-name>
  ```
- Checklist for schema changes:
  - [ ] The relevant `supabase/schemas/*.sql` file is updated

### Rule 5 — File structure

Do not create files outside these locations without explicit instruction:

```
/
├── source/
│   ├── index.html          — HTML entry point (loads js/app.js + js/app.css)
│   ├── css/                — modular stylesheets bundled into app.css
│   ├── js/                 — TypeScript application modules (entry: app.ts)
│   ├── fonts/              — self-hosted Inter webfonts
│   ├── media/              — icons and static assets
│   └── sw.js               — service worker
├── tests/
│   ├── *.spec.ts           — Playwright E2E specs
│   ├── test.ts             — shared Playwright fixtures/helpers
│   └── unit/
│       ├── unit.test.ts    — bun test entry (replays the suites)
│       ├── testing.ts      — section harness (asserts + runner)
│       ├── setup/dom.ts    — happy-dom preload
│       └── suites/*.ts     — unit suites
├── scripts/                — build, cache-bump, hooks, release, serve scripts
├── supabase/
│   ├── schemas/            — SQL schema files, one per table
│   ├── migrations/         — generated migrations
│   └── seed.sql            — optional local seed script (currently no-op)
├── docs/
│   ├── SPEC.vmd            — source of truth, do not modify unless instructed
│   ├── design.md
│   └── VMD.md
├── AGENTS.md               — this file
├── README.md               — keep in sync with all changes
├── package.json / bun.lock — dependencies and scripts
├── bunfig.toml             — bun test preload (happy-dom)
├── tsconfig.json           — strict app config
├── tsconfig.test.json      — test config (inherits strict)
└── playwright.config.ts    — E2E config (webServer: `bun run dev`)
```

Generated artifacts (`dist/`, `node_modules/`, `playwright-report/`, `test-results/`) are gitignored.

### Rule 6 — Tech stack

Do not introduce dependencies or frameworks beyond what is listed here.

- TypeScript throughout (`source/js/*.ts`), strict mode. No plain `.js` app modules.
- **Bun** is the runtime, bundler (`bun build`), and unit test runner (`bun test`).
- **Preact** + **Preact Signals** + **htm** for UI, installed from npm and bundled — no import map, no CDN
- **Supabase JS client** from npm (imported in `sync.ts`)
- **marked** + **dompurify** for markdown; **happy-dom** for the unit-test DOM
- All crypto via the native **Web Crypto API** — no third-party crypto libraries
- All styling via plain CSS and CSS variables — no frameworks or preprocessors
- If a task seems to require a new dependency, **stop and ask**

### Rule 7 — Code conventions

- Two-space indentation throughout
- CSS variables for all colours, sizes, and font definitions — no hardcoded values
- No `var` — only `const` and `let`
- Async/await throughout — no raw Promise chains
- All encryption and decryption must go through `crypto2.ts`. Do not inline crypto logic elsewhere.
  Exception: `biometrics.ts` performs its own AES-GCM wrapping for the device-local passphrase
  seal. That key is never used for document encryption.
- All Supabase calls must go through `sync.ts` (`remoteSync`). Do not call Supabase from UI code.
- All `localStorage` reads and writes must go through the `store` slots in `utils.ts`.
  Do not access `localStorage` directly from UI code.
  Only the encrypted document payload (`vmd_data_enc`) is ciphertext; mode/theme/username,
  sync timestamps, the Supabase config, and the inbox queue are non-secret metadata stored
  in plaintext.

### Rule 8 — Definition of done

A task is complete only when all of the following are true:

- [ ] The feature behaves exactly as described in `SPEC.vmd`
- [ ] `bun run typecheck` passes (0 errors, app and tests)
- [ ] All existing unit tests pass (`bun run test:unit`)
- [ ] All existing Playwright tests pass (`bun run test:e2e`)
- [ ] New/updated unit and/or Playwright tests cover the changed behaviour
- [ ] `README.md` is updated to reflect the change
- [ ] If the schema changed, the relevant `supabase/schemas/*.sql` file is updated and the migration generated
- [ ] No new dependencies have been introduced
- [ ] No files exist outside the locations defined in Rule 5

### Rule 9 — Task size

Do not implement more than one atomic feature per session.
If a task spans multiple items on the list below, split it.

- App shell and splash screen
- localStorage encrypted read/write via `storage` module
- Passphrase setup and unlock screen
- PBKDF2 key derivation via `crypto` module
- Node rendering and editing
- Node focus and keyboard navigation
- Node description field
- Node collapse and expand
- Node indent and unindent
- Node move (up/down)
- Node delete
- Multi-select
- Zoom and breadcrumb
- Undo/redo stack
- Markdown rendering
- Search
- Keyboard shortcuts modal
- Options panel (theme, purge, repository link)
- Supabase Auth (sign up, sign in, sign out)
- Cloud sync (upload and download encrypted document)
- Status toolbar

### Rule 10 — When in doubt, stop

If any of the following are true, stop and ask rather than proceeding:

- The SPEC does not clearly describe the expected behaviour
- Implementing the task requires changing `SPEC.vmd`
- Implementing the task requires a new dependency
- Implementing the task requires files outside the defined structure
- A test is failing and the fix is not obvious
- Two rules in this document appear to conflict

## Known drift (documented)

These are known gaps between the spec and the current implementation. Do not assume the
feature exists; update this list when a gap is closed.

- **Undo/Redo** is listed in `docs/SPEC.vmd` (`Ctrl+Z` / `Ctrl+Shift+Z`) but is not implemented.
  Do not document or reference it as a working feature.

---

### Rule 11 — Conventional Commits are required

All commits (human and agent-authored) must use a Conventional Commits header:

```
type(scope)!: subject
```

- Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- Scope is optional but recommended for non-trivial changes
- `!` is required for breaking changes; also include `BREAKING CHANGE:` in the body when applicable
- Auto-generated merge commit messages are allowed

Examples:

- `feat(sync): add remote retry backoff`
- `fix(ui)!: rename storage mode label`
- `chore: bump sw cache versions`

Enforcement:

- Local `commit-msg` hook: run `bun run sw:hooks` once per clone
- CI validation: all commits in push/PR range must pass Conventional Commits checks
