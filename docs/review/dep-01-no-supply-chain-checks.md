# No vulnerability, provenance or code-scanning checks in CI

- **Severity:** Low
- **Confidence:** measured (`bun audit` reports no known vulnerabilities across 67 packages today; no audit, dependency-review, CodeQL or Scorecard step in the workflows)
- **Spec impact:** none

## Description

Dependabot exists (weekly, npm and GitHub Actions, minor/patch grouped), but nothing else watches the supply chain. The repo uses `bun.lock`, and Dependabot's `npm` ecosystem may not update Bun lockfiles; check that its PRs actually change `bun.lock` or use the `bun` ecosystem if available. Minor and patch updates are batched into one PR, so a malicious release is merged together with routine bumps. Updates can be adopted the day they publish, with no cooldown. Pull requests do not run dependency review. The deploy has no build provenance.

## Evidence

- [.github/dependabot.yml](../../.github/dependabot.yml)
- [.github/workflows/ci.yml](../../.github/workflows/ci.yml)

## Suggested fix

- Add `bun audit` and `actions/dependency-review-action` to PR checks.
- Enable CodeQL for JavaScript/TypeScript, and the OpenSSF Scorecard action if wanted.
- Add a Dependabot `cooldown` (for example 3 days) and keep runtime dependencies (`preact`, `marked`, `dompurify`, `@supabase/supabase-js`) out of the batched group so they get individual review.
- Attest the deployed artifact with `actions/attest-build-provenance`.

## Tests

None; CI configuration only.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0B — Quick wins (operations and CI)](README.md#phase-0b)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [dep-02](dep-02-supabase-client-footprint.md)
