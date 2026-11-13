# Recurrence edge cases, and overdue state that does not refresh

- **Severity:** Low
- **Confidence:** verified (probe: `advanceDueDate('2026-10-01', '0d')` returns the same date; `'99999999d'` returns `NaN-NaN-NaN`; `'9999y'` returns `12025-10-01`)
- **Spec impact:** SPEC defines `rec:` as `\d*(y|m|w|d)`; bounds are an addition

## Description

- `rec:0d` (or `0w`, `0m`, `0y`) "advances" a task to the same due date, so the check-off never completes it: a task with `rec:0d` can never be marked done.
- A huge count (`rec:99999999d`) produces `due:NaN-NaN-NaN`, which no longer parses as a due date, so the task silently loses its due date and recurrence. A large year count gives a five-digit year that also fails the date pattern.
- Overdue and "pending" state is computed when task data changes. A tab left open across midnight keeps showing yesterday's classification until the next edit.

## Evidence

- [source/js/meta.ts](../../source/js/meta.ts#L158) (`advanceDueDate`)
- [source/js/outline.ts](../../source/js/outline.ts#L80) (`tryAdvanceRecurrence`)
- [source/js/tasks.ts](../../source/js/tasks.ts#L54)

## Suggested fix

Treat a zero or out-of-range count (for example above 999 days or 100 years) as an invalid recurrence: it should not match, so the task completes normally. Return `null` when the result is not a valid four-digit-year date. Add a timer (or `visibilitychange` handler) that bumps a "today" signal at local midnight so the task selectors recompute.

## Tests

Unit tests in `metaTests.ts` for zero, huge and year-overflow values; a fake-timer test for the midnight refresh.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0A — Quick wins (code)](README.md#phase-0a)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [roadmap-06](roadmap-06-outline-statistics.md)
