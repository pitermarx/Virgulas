# How large can a document grow before it lags (including old devices)

- **Priority:** P5
- **Type:** measurement, then fixes
- **Spec impact:** none; the result could become a documented limit

## Question

Where does the app start to feel slow, and how does that move on old phones and low-end laptops?

## What is known (measured in Bun, not in a browser)

For a generated outline of 20,000 nodes (about 6,700 tasks):

| Operation | Result |
| --- | --- |
| Build the tree through the API | about 170 ms |
| `serialize()` | 18 to 45 ms each |
| JSON size | 2.2 MB before gzip |
| `deserialize()` | about 148 ms |
| Heap after load | about 65 MB |
| `getAllTasks()` | about 4 ms |

Those are fast desktop numbers. The costs that matter on a phone are per keystroke or per save and are not in this table: the task selectors rescan everything (perf-01), editing a node re-renders its visible subtree and re-runs markdown (perf-02), each save serialises, gzips and encrypts the whole document on the main thread, and a remote save uploads all of it (sync-07). A realistic old-device slowdown is 4 to 6 times.

## Suggested test plan

1. **Generate fixtures** of 1k, 5k, 20k and 50k nodes with realistic text (tags, due dates, descriptions, markdown) and a wide and a deep variant (deep trees also stress the recursive functions).
2. **Browser benchmark** with Playwright: Chromium with CDP `Emulation.setCPUThrottlingRate` at 4 and 6, WebKit for Safari timing. Record: load and unlock time (with the real 600k PBKDF2), time to first render, keystroke-to-paint latency in a leaf node and in a node with 1,000 visible descendants, save time, and memory.
3. **Real devices:** an older iPhone and a low-end Android, using the Safari and Chrome remote inspectors. PBKDF2 at 600k iterations is the likely first wall on a phone (seconds per unlock), so measure it separately.
4. **Budgets:** for example keystroke latency under 50 ms, unlock under 3 s on the reference device, and a documented supported size ("comfortable up to N nodes").
5. **Guard in CI:** keep the Bun benchmark as a unit test with a generous budget so regressions show up (perf-04), and run the browser benchmark nightly.

## Likely fixes if the numbers are bad

Targeted subscriptions and memoisation (perf-02), incremental task index (perf-01), moving serialise, compress and encrypt into a Worker, windowed rendering for huge subtrees, and a size warning in the UI near the localStorage quota.

## Tests

The benchmark suite is the test; commit the fixtures generator, not the fixtures.

<!-- roadmap -->
## Roadmap position

- **Phase:** [1 — Safety net and baselines](README.md#phase-1)
- **Size:** M
- **Do these first:** —
- **Unblocks:** [perf-01](perf-01-grouped-tasks-per-keystroke.md), [perf-02](perf-02-subtree-rerender-no-render-cache.md), [perf-04](perf-04-per-node-memory-footprint.md), [web-03](web-03-core-web-vitals-measurement.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** —
