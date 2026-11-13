# Dead and test-only code

- **Severity:** Low
- **Confidence:** measured (usage counts across `source/`, `tests/`, `scripts/`)
- **Spec impact:** none

## Description

- `hasSupabaseClient()` always returns `true`; the `hasSupabase` checks and fields that depend on it are dead branches.
- `outline.getStats`, `outline.updateNode`, `formatMeta` and `persistence.hasData` have no production callers (only tests, or none).
- `NodeSnapshot` and `OutlineStats` types are unused.

(The legacy runner `tests/browserTestsInNode.js` and the stale root `plan.md` this item used to
list are gone: the runner was deleted earlier and the remaining work plan items live in
[roadmap-08](roadmap-08-account-page-extensions.md).)

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts#L102)
- [source/js/outline.ts](../../source/js/outline.ts)

## Suggested fix

Remove `hasSupabaseClient` and the dead branches, and either use or delete the unused helpers (move test-only helpers into test utilities). Run `bun run typecheck` and both suites after each deletion.

## Tests

Existing suites; deletion should not need new ones.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0A — Quick wins (code)](README.md#phase-0a)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [roadmap-06](roadmap-06-outline-statistics.md)
