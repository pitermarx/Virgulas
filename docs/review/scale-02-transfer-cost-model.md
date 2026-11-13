# Transfer cost grows with document size, devices and the poll loop

- **Severity:** Medium
- **Confidence:** code-read; figures are an illustrative model, not measured
- **Spec impact:** none

## Description

Every sync moves the whole base64 document (sync-07). The unchanged-write-back fix (sync-02) removed the worst poll term; the rest of this model is what remains. Illustrative model: for a 100 KB encrypted document, one device doing a full pull plus push per minute transfers about 100 KB × 2 × 1,440 ≈ 280 MB per day. With two devices ping-ponging, each device downloads about 140 MB per day and uploads the same. A handful of such users would exceed the 5 GB monthly egress of a free Supabase project. The 60 s `select updated_at` poll alone is small (about 1,440 tiny requests per device per day) but still keeps a connection and a token refresh going in background tabs (sync-09).

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts#L513) (`startPolling`)
- [supabase/schemas/outlines.sql](../../supabase/schemas/outlines.sql)

## Suggested fix

The unchanged-write-back fix already removed the largest term. Then: poll only while the tab is visible and online, raise the interval with backoff when nothing changes, use conditional reads, and measure real egress before deciding on delta sync or Storage. Add a dashboard alert on egress and request volume.

## Tests

A counter-based Playwright test that bounds requests and bytes over a simulated idle minute with two devices.

<!-- roadmap -->
## Roadmap position

- **Phase:** [4 — Decide and measure](README.md#phase-4)
- **Size:** S
- **Do these first:** [sync-09](sync-09-retry-and-polling-hygiene.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sync-07](sync-07-full-document-transfer-and-double-download.md)
- **Related:** [sync-09](sync-09-retry-and-polling-hygiene.md)
