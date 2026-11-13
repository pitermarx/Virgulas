# Loose typing and unchecked scripts

- **Severity:** Low
- **Confidence:** measured (112 uses of `any` in `source/js`: `ui.ts` 48, `app.ts` 24, `sync.ts` 15)
- **Spec impact:** none

## Description

`tsconfig.json` is strict but only includes `source/js/**/*.ts`, with `allowJs: false`, so `scripts/*.mjs` are never type-checked. `any` appears in event handlers, `node: any` props, `user: any`, and the sync types (`[key: string]: any`). `noUncheckedIndexedAccess` is off.

## Evidence

- [tsconfig.json](../../tsconfig.json)
- [source/js/ui.ts](../../source/js/ui.ts), [source/js/sync.ts](../../source/js/sync.ts)

## Suggested fix

Type the Preact components (`Node` props, `JSX` event types), give `SyncNode` an exact shape plus a runtime validator for remote payloads (also fixes sync-03), and add an ESLint or tsc rule that counts `any` and fails on increases. Optionally enable `checkJs` for scripts or convert them to `.ts`.

## Tests

`bun run typecheck` must stay at zero errors.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** M
- **Do these first:** [struct-02](struct-02-duplicated-remote-push-logic.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
