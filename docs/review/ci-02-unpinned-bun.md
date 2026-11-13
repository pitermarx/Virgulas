# CI uses `bun-version: latest`

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

Every job installs the latest Bun. A new Bun release can change bundler output, `bun test` behaviour or the lockfile format without any commit, and the deploy build is produced by whatever version was current. Actions are already pinned by SHA, which makes this the odd one out.

## Evidence

- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
- [package.json](../../package.json)

## Suggested fix

Pin an exact Bun version in the workflow (and in `packageManager` or a `.bun-version` file), and bump it deliberately through a PR that runs the full suite.

## Tests

None; CI stays green on the pinned version.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0B — Quick wins (operations and CI)](README.md#phase-0b)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [ci-01](ci-01-duplicated-setup-per-shard.md)
