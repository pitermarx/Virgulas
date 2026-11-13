# Per-node memory footprint

- **Severity:** Low
- **Confidence:** measured (20k nodes: heap about 65 MB, `serialize` 18 to 45 ms, `deserialize` about 148 ms, 2.2 MB of JSON before gzip)
- **Spec impact:** none

## Description

Each node is a `createModel` instance with four signals, a snapshot-producing `.value`, and about 20 closures. `serialize` allocates a snapshot per node, then maps it twice. These costs are acceptable at 20k nodes, but they scale linearly and run on the main thread on every save.

## Evidence

- [source/js/outline.ts](../../source/js/outline.ts) (`nodeFactory`, `serialize`)

## Suggested fix

Low priority. Make `serialize` read signals directly (no intermediate snapshot) and move compress and encrypt for large documents into a Worker. Share method closures through a prototype or class instead of per-node closures. Only do this if real users approach 50k+ nodes.

## Tests

Keep the probe as a unit benchmark with a generous budget to catch regressions.

<!-- roadmap -->
## Roadmap position

- **Phase:** [7 — Outline UI: performance and accessibility](README.md#phase-7)
- **Size:** S
- **Do these first:** [perf-08](perf-08-document-size-limits-and-old-devices.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
