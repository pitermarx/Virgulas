# Agents Guidance

This document defines the rules every agent or contributor **must** follow when making changes to this repository.

---

## Rule 1 — Keep README.md in sync

`README.md` is the authoritative description of everything the app does.

**Whenever you add, remove, or change a feature in `index.html` you must update `README.md` in the same commit/PR.**

Checklist for README changes:

- [ ] Every keyboard shortcut listed in the `## Keyboard handling` table matches what `handleBulletKey` and the global keydown listener actually do.
- [ ] Every HTML element mentioned in `## HTML structure` exists in the `<body>` of `index.html`.
- [ ] Every CSS custom property in `## CSS architecture` exists in the `:root` block of `index.html`.
- [ ] The `## Import / Export` section reflects the current Markdown format (bullet lines, description lines, indentation depth).
- [ ] The `## Search` section mentions all fields that are searched (currently `text` and `description`).
- [ ] The `## Zoom behaviour` section uses the correct keys (currently `Alt+←` / `Alt+→`, **not** `Ctrl+←`).
- [ ] Any new modal, toolbar button, or UI affordance is listed in `## HTML structure` with a short description.
- [ ] Any new edge case is added to `## Known edge cases to handle`.

---

## Rule 2 — Every feature must have a Playwright test

All tests live in `tests/outliner.spec.js`.

**Whenever you add or change behaviour in `index.html` you must add or update the corresponding test(s) in that file.**

Guidelines for tests:

- Group related tests with `test.describe(...)` blocks that match the feature name.
- Rely on Playwright's built-in auto-waiting assertions (e.g. `expect(locator).toBeVisible()`) rather than explicit `waitForSelector` calls. Use `waitForSelector` only when you need to wait for a selector before performing an action that has no auto-waiting of its own.
- Use the `beforeEach` that already exists (clears `localStorage` and reloads) — do **not** add a separate `beforeEach` that contradicts it.
- Prefer asserting on visible DOM changes (count of rows, class names, visibility) over asserting on internal state.
- For keyboard shortcuts, use `page.keyboard.press(...)` with the exact key string (e.g. `'Alt+ArrowRight'`, `'Control+Enter'`).
- When a new toolbar button is added, add tests that: (a) it is visible, (b) clicking it opens the expected modal/action.
- When a new keyboard shortcut is added, add a test that exercises the shortcut and verifies the resulting DOM change.

---

## How to run tests

```bash
npm test            # runs Playwright tests (headless, chromium + firefox)
npm run test:headed # runs with browser visible (useful for debugging)
npm run test:ci     # runs with CI reporters (JSON + GitHub summary)
```

Tests use a local HTTP server on port 3000 (started automatically by Playwright).

---

## Scope of this repository

- **One file app**: all product logic lives in `index.html` (HTML + `<style>` + `<script type="module">`).
- **No build step**: do not introduce a build tool, bundler, or external runtime dependency.
- **No external dependencies**: the `<script>` tag has no `src`; all JS is inline.
- **Tests only**: `package.json`, `playwright.config.js`, and `tests/` are for testing only and must not be imported by `index.html`.
