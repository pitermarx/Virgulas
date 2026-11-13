# Editing a node re-renders its whole visible subtree, and markdown has no render cache

- **Severity:** Medium
- **Confidence:** code-read (not benchmarked in a browser)
- **Spec impact:** none

## Description

`node.value` reads all five of a node's signals. `Node`, `NodeBody`, `NodeText` and `NodeDesc` each use it, so changing one field re-renders all four components for that node. `Node` maps its children to new vnodes with no memoisation, so every visible descendant re-renders too. Each re-render calls `renderInlineMarkdown` (marked, DOMPurify and DOM round trips) for text and description. There is no virtualisation, so a node with a large open subtree makes each keystroke cost one render per descendant.

## Evidence

- [source/js/ui.ts](../../source/js/ui.ts) (`Node`, `NodeBody`, `NodeText`, `NodeDesc`)
- [source/js/outline.ts](../../source/js/outline.ts) (`get value()`)
- [source/js/markdown.ts](../../source/js/markdown.ts)

## Suggested fix

Subscribe to individual signals (`node.text.value`, and so on) in the component that needs them. Wrap child list items in `memo` keyed by id. Add a small LRU cache for `renderInlineMarkdown` keyed by `(text, decorateMeta)`. Consider windowing for very large subtrees.

## Tests

Playwright performance smoke: typing in a node with 1,000 open descendants stays within a frame budget; unit test the cache for key and eviction.

<!-- roadmap -->
## Roadmap position

- **Phase:** [7 — Outline UI: performance and accessibility](README.md#phase-7)
- **Size:** L
- **Do these first:** [perf-08](perf-08-document-size-limits-and-old-devices.md), [sec-10](sec-10-markdown-sanitizer-roundtrip.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-10](sec-10-markdown-sanitizer-roundtrip.md)
- **Related:** [web-03](web-03-core-web-vitals-measurement.md)
