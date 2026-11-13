# Sanitised HTML is re-parsed and re-serialised twice

- **Severity:** Low
- **Confidence:** code-read
- **Spec impact:** none

## Description

`finalizeMarkdown` runs DOMPurify, then `decorateSearchTokens` parses the output into a `<template>` and reads `innerHTML`, then (for tasks) `decorateMetaChips` does the same again. Re-serialising sanitised HTML is a known mutation-XSS vector class. The tag allow-list is small and has no SVG or MathML, so the practical risk is low. It also costs three parse cycles per render.

## Evidence

- [source/js/markdown.ts](../../source/js/markdown.ts) (`finalizeMarkdown`, `decorateSearchTokens`, `decorateMetaChips`)

## Suggested fix

Call DOMPurify with `RETURN_DOM_FRAGMENT: true`, run both decorators on that one fragment, and serialise once at the end. Merge the two near-identical text-node walkers (see struct-03).

## Tests

Existing `markdownTests.ts` plus new cases that compare output before and after the refactor, and a mutation-XSS payload corpus.

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** S
- **Do these first:** —
- **Unblocks:** [perf-02](perf-02-subtree-rerender-no-render-cache.md), [web-01](web-01-trusted-types-and-dns-records.md)
- **Its decision changes how these are built:** [perf-02](perf-02-subtree-rerender-no-render-cache.md), [struct-03](struct-03-minor-duplications.md), [web-01](web-01-trusted-types-and-dns-records.md)
- **Shaped by:** —
- **Related:** —
