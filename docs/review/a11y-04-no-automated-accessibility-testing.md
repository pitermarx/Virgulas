# No automated accessibility testing

- **Severity:** Low
- **Confidence:** measured (no `axe` or equivalent in `package.json` or `tests/`)
- **Spec impact:** none

## Description

The SPEC lists an accessibility baseline (one `h1`, landmarks, skip link, reduced motion, forced colours, AA body text), but only `website-spec` checks parts of it. There is no automated rule-based scan (axe) and no keyboard-only journey test. a11y-01 to a11y-03 would have been caught by one.

## Evidence

- [package.json](../../package.json)
- [tests/e2e/website-spec.spec.ts](../../tests/e2e/website-spec.spec.ts)

## Suggested fix

Add `@axe-core/playwright` as a dev dependency (Rule 6 requires approval for any new dependency) and scan the main views: lock screen, outline, Options, tasks panel, conflict dialog, in light and dark themes. Add a keyboard-only journey (unlock, add, indent, collapse, zoom, search, open Options). Fail CI on new violations, with a baseline file for the known ones.

## Tests

The new specs are the tests.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** M
- **Do these first:** —
- **Unblocks:** [a11y-01](a11y-01-tree-semantics-and-pointer-only-controls.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [a11y-03](a11y-03-sync-indicator-contrast.md)
