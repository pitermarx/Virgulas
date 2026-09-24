---
name: release
description: 'Release staged changes in Virgulas: run cache-busting scripts, branch, commit with Conventional Commits, push, and open a PR. Use when the user asks to create a release, ship changes, or publish staged work.'
argument-hint: 'optional: describe the changes to include in the PR description'
---

# Virgulas Release Workflow

## When to Use

- User asks to "create a release", "ship", "publish", or "open a PR" for staged changes.

## Decision: which scripts to run

Before branching, determine what changed:

| Changed files | Script to run |
|---|---|
| `source/css/`, `source/js/`, `source/index.html`, `source/sw.js`, `source/fonts/`, `source/media/` | `bun run sw:bump` |
| Nothing in the above groups | No script needed |

Run `bun run sw:bump` whenever any app file changes. It hashes the source groups
and bumps `APP_CACHE`/`FONTS_CACHE` in `source/sw.js`. It is idempotent and safe to
run even when nothing changed — it will report "nothing bumped".

## Procedure

### 1. Inspect staged changes

```bash
git diff --staged
```

Understand what changed to write the commit message and decide which scripts to run.

### 2. Run cache-busting

```bash
bun run sw:bump
```

Then stage any files modified by the script:
```bash
git add source/sw.js scripts/.sw-cache-hashes.json
```

### 3. Create a branch

Name it after the primary type and scope of the change, following the repo's branch naming convention:
```
feat/<short-slug>
fix/<short-slug>
chore/<short-slug>
```

```bash
git checkout -b feat/<slug>
```

> The staged index travels with the checkout — no need to stash.

### 4. Commit

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope)!: subject
```

- Types: `feat`, `fix`, `perf`, `refactor`, `revert`, `chore`, `style`, `docs`, `test`
- Breaking changes: append `!` after scope
- Include a bullet-point body listing each logical change

```bash
git commit -m "feat(ui): short summary

- Detail 1
- Detail 2
- Bump APP_CACHE vN → vN+1"
```

### 5. Push and open PR

```bash
git push -u origin <branch-name>
gh pr create \
  --title "<same as commit subject>" \
  --body "## Changes\n\n- ...\n- ..." \
  --base main \
  --head <branch-name>
```

## Notes

- `bun run sw:bump` is automatically called by `bun install` (postinstall), so cache versions are refreshed when dependencies change.
- The `pre-push` Git hook (if installed via `bun run sw:hooks`) also runs `sw:bump` and aborts if `sw.js` was modified but not committed.
- Do **not** skip `sw:bump` — stale caches will serve outdated app files to users.
- The app is built by `bun run build` (`bun scripts/build-bun.mjs`), which bundles `source/js/app.ts` and the `source/css/*.css` modules into `dist/js/app.js` + `dist/js/app.css`, then stamps the version into `dist/index.html` and `dist/version.json`. Dependencies are resolved from `node_modules`; there is no `source/vendor/` directory.
