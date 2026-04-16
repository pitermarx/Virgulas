# Roadmap

## Current test status

Run: `npm run test:e2e`

## Spec file status

| Spec | Status | Notes |
|---|---|---|
| auth.spec.ts | DONE | 11 pass |
| sync.spec.ts | DONE | 7 tests |
| multiselect.spec.ts | DONE | 6 tests |
| raw.spec.ts | DONE | 4 tests |
| debug.spec.ts | DONE | 3 tests |

## Removed features

- **Quick Unlock** (WebAuthn PRF) — not part of the app; removed from tests, docs, and CSS
- **Undo / Redo** — not part of the app; removed from tests, docs, and SPEC

## Guardrails

- Keep canonical crypto API shape: `encrypt(text, passphrase, salt)` / `decrypt(ciphertext, passphrase, salt)`
- No test-only internals on `window.App` — `window.App` has been removed entirely
- `npm test` must run E2E + unit harness
