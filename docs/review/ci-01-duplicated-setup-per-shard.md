# Each CI shard repeats the same setup

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

Each of the three E2E shards runs `bunx playwright install --with-deps` (no browser cache), starts a full local Supabase stack (container image pulls), and runs the whole unit suite, so unit tests execute three times per run. Bun dependencies and Playwright browsers are not cached.

## Evidence

- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)

## Suggested fix

Run unit tests and typecheck once in a separate job. Cache `~/.cache/ms-playwright` and the Bun install cache. Cache the Supabase images or share them through a setup job. Keep the sharding.

## Tests

CI wall-clock and job minutes before and after.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0B — Quick wins (operations and CI)](README.md#phase-0b)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [ci-02](ci-02-unpinned-bun.md)
