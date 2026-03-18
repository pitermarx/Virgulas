# Agents

This document defines the rules every agent or contributor must follow, and everything needed
to run the app and tests locally. Read it completely before starting any task.

---

## Environment setup

### Prerequisites

- Node.js 20 or later (the app has no build step — Node is only needed for Playwright)
- A Supabase project (free tier is sufficient)
- For testing WebAuthn PRF: Chrome 108+, Edge 108+, or Safari 16.4+
  Firefox does not support the PRF extension; quick-unlock tests are Chromium-only

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

The app uses ES module imports and cannot be opened directly from the filesystem.

Serve the app locally:

```bash
npm run serve
```

### Import map

Preact, Preact Signals, and the Supabase client are loaded via CDN. The import map in `index.html` must be:

```html
<script type="importmap">
{
  "imports": {
    "preact":          "https://esm.sh/preact@10.19.3",
    "preact/hooks":    "https://esm.sh/preact@10.19.3/hooks",
    "@preact/signals": "https://esm.sh/@preact/signals@1.2.3"
  }
}
</script>
```

The Supabase client is loaded as a regular module import:

```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.1'
```

Do not change these URLs or versions without updating this file.

### Database setup

Initialize local Supabase files (first time only):

```bash
npm run db:init
```

Start local Supabase:

```bash
npm run db:start
```

Playwright local tests assume `npm run db:start` has been run and `.env` exists.
Tests override `localStorage.supabaseconfig` from `.env` before every page load.

Get local URL and anon key for `.env`:

```bash
npm exec supabase -- status
```

Generate a migration after editing `supabase/schemas/*.sql`:

```bash
npm run db:migrate -- <migration-name>
```

Apply migrations locally (no seed):

```bash
npm run db:reset
```

Tests that require a signed-in state should first attempt sign-in and create the user if it does not exist.

Stop local Supabase:

```bash
npm run db:stop
```

### Production migrations

Link the hosted project and push migrations:

```bash
npm exec supabase -- login
npm exec supabase -- link --project-ref <your-project-ref>
npm exec supabase -- db push --linked
```

Preview migration application without applying:

```bash
npm exec supabase -- db push --linked --dry-run
```

### Running tests

```bash
npm test                        # all tests
npm test -- tests/sync.spec.ts  # single file
npm test -- --headed            # visible browser
```

Playwright starts a local static server automatically — no separate `npx serve` needed.

- Local Playwright runs require local Supabase credentials (`.env` or `supabase status`) and fail fast if missing
- Tests covering **WebAuthn PRF** use Playwright's virtual authenticator API — no hardware required; Chromium only
- All other tests run in Chromium and Firefox.

### CI/CD

Required repository secrets for CI:

- `SUPABASE_PROJECT` for main-branch migration publishing
- `SUPABASE_ACCESS_TOKEN` for main-branch migration publishing

Main-branch CI must always run migration publish before deploy:

```bash
SUPABASE_PROJECT_REF="$SUPABASE_PROJECT"
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push --linked --include-all
```

---

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

### Rule 3 — Every feature must have a Playwright test

Whenever you add or change a feature or behaviour, add or update the corresponding test(s).

- Tests live in `tests/`
- A feature is not considered implemented until its test passes
- Tests must cover the happy path and all edge cases described in `SPEC.vmd`
- Do not mark a task complete if any test is failing

### Rule 4 — Update schema files for any database schema change

Whenever you add, modify, or remove a table, column, index, policy, or function,
update the corresponding file in `supabase/schemas/` in the same commit.

- Schema files live in `supabase/schemas/` (e.g. `outlines.sql`)
- Migrations are auto-generated by Supabase from the schema diff — do not write them manually
- To apply and generate a migration after editing a schema file:
  ```bash
  npm run db:migrate -- <migration-name>
  ```
- Checklist for schema changes:
  - [ ] The relevant `supabase/schemas/*.sql` file is updated

### Rule 5 — File structure

Do not create files outside these locations without explicit instruction:

```
/
├── source/
│   ├── index.html          — single-file entry point; HTML, CSS references, and JS entrypoint
│   ├── css/                — stylesheets
│   ├── js/                 — application modules
│   └── media/              — icons and static assets
├── tests/
│   └── *.spec.ts           — Playwright tests
├── supabase/
│   ├── schemas/            — SQL schema files, one per table
│   └── seed.sql            — optional local seed script (currently no-op)
└── docs/
    ├── SPEC.vmd            — source of truth, do not modify unless instructed
    ├── AGENTS.md           — this file, do not modify unless instructed
    └── README.md           — keep in sync with all changes
```

### Rule 6 — Tech stack

Do not introduce dependencies or frameworks beyond what is listed here.

- Single self-contained `source/` folder — no build step, no bundler; entry point is `source/index.html`
- **Preact** and **Preact Signals** via CDN import map (see import map above)
- **Supabase JS client** via CDN
- All crypto via the native **Web Crypto API** — no third-party crypto libraries
- All styling via plain CSS and CSS variables — no frameworks or preprocessors
- If a task seems to require a new dependency, **stop and ask**

### Rule 7 — Code conventions

- Two-space indentation throughout
- CSS variables for all colours, sizes, and font definitions — no hardcoded values
- No `var` — only `const` and `let`
- Async/await throughout — no raw Promise chains
- All encryption and decryption must go through the `crypto` module in `index.html`
  Do not inline crypto logic elsewhere
- All Supabase calls must go through the `db` module in `index.html`
  Do not call Supabase directly from UI code
- All localStorage reads and writes must go through the `storage` module in `index.html`
  Do not access `localStorage` directly from UI code
  All values written to localStorage except `vmd_salt` must be encrypted

### Rule 8 — Definition of done

A task is complete only when all of the following are true:

- [ ] The feature behaves exactly as described in `SPEC.vmd`
- [ ] All existing Playwright tests pass
- [ ] A new or updated Playwright test covers the changed behaviour
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
- Raw mode
- Keyboard shortcuts modal
- Options panel (theme, purge, repository link)
- Quick unlock via WebAuthn PRF
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