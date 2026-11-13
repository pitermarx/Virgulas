# Large test suite, but invariants are not tested

- **Severity:** Low
- **Confidence:** measured (436 unit tests pass in about 2.8 s; roughly 12k lines of tests for 7k lines of source; no coverage run configured)
- **Spec impact:** none

## Description

The suite is broad, yet a verified bug (data-02's dropped fields) passed it. Tests assert examples, not invariants such as "serialize then deserialize is the identity" or "merge is commutative and idempotent". No coverage report, property-based or mutation testing exists, so nobody can see which branches the 12k lines miss. Unit suites are picked up automatically from `tests/unit/suites/`, but nothing checks invariants, so a missing property test stays invisible.

## Evidence

- [tests/unit/suites/](../../tests/unit/suites/) (the bun suites: `sync.test.ts`, `outline.test.ts`, `merge.test.ts`)

## Suggested fix

- Add randomised round-trip and merge-property tests (a small seeded generator is enough; a new dependency such as `fast-check` needs approval under Rule 6).
- Run `bun test --coverage` in CI and publish the summary; set a floor only after seeing the numbers.
- Replace manual registration with a glob import of `suites/*.ts`, or add a check that fails when a suite file is not registered.

## Tests

The items above are tests.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** M
- **Do these first:** —
- **Unblocks:** [data-05](data-05-denormalized-parent-children-no-tombstones.md), [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
