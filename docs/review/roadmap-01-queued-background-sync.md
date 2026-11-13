# Queued background sync

- **Priority:** P3 (SPEC ROADMAP feature)
- **Type:** feature
- **Spec impact:** SPEC ROADMAP; the current text says a failed upload is retried 3 times and then abandoned until the next write

## Description

Queue remote changes locally and run them when the connection returns, instead of losing the push while offline.

## What the code does today

The local ciphertext is always written first, so the document itself is not lost. The remote push is retried with backoff (3 retries), then dropped. It is retried only on the next save, because the failure sets `syncStatus` to `error` or `offline` and nothing listens for the `online` event. The local copy then differs from the server until the user edits again.

## Suggested approach

- Smallest useful version: remember "remote dirty" (a flag with the local version number, stored in the non-secret metadata), and on `online`, on `visibilitychange` to visible and at the next poll, run one sync pass. Since every upload is the whole document, there is nothing to queue beyond the flag; a queue of operations only makes sense with a delta protocol (sync-07).
- Use the Background Sync API where available only as a bonus; it is Chromium-only.
- Build on one `syncOnce` function (struct-02) and the revision check (sync-04), otherwise a replayed offline push can overwrite newer remote data (sync-01).
- Show the pending state in the status indicator ("N changes waiting", err-03).

## Open questions

Is whole-document "dirty flag and retry" acceptable, or is the goal true offline operation queues (which require the data-model work in data-05)?

## Tests

Playwright with the context set offline then online: the change reaches the mock backend without another edit.

<!-- roadmap -->
## Roadmap position

- **Phase:** [9 — Features](README.md#phase-9)
- **Size:** M
- **Do these first:** [err-03](err-03-sync-errors-without-detail.md), [struct-02](struct-02-duplicated-remote-push-logic.md), [sync-04](sync-04-no-compare-and-swap-on-upsert.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sync-07](sync-07-full-document-transfer-and-double-download.md)
- **Related:** —
