# Stale-while-revalidate can serve an `app.js` whose chunk no longer exists

- **Severity:** Medium
- **Confidence:** code-read
- **Spec impact:** none

## Description

`app.js` is served from the cache while it revalidates. It dynamically imports a content-hashed Supabase chunk that is deliberately not in `APP_SHELL`. After a deploy the old chunk is gone from the server. A user on the cached old `app.js` who has not loaded the chunk before (for example a Local user who switches to Remote mid-session) gets a failed dynamic import. `skipWaiting` plus `clients.claim` also allow a mixed old/new bundle.

## Evidence

- [source/sw.js](../../source/sw.js)
- [scripts/build-bun.mjs](../../scripts/build-bun.mjs) (`splitting: true`)

## Suggested fix

Emit a build manifest and have the service worker precache the chunk (and any other hashed output) at install time, so every cached `app.js` has its chunks. Alternatively, retry a failed dynamic import after refreshing the cache, and prompt for reload when a new service worker takes control.

## Tests

Playwright: install old build, deploy new build, switch to Remote without reloading, and assert sync loads.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** S
- **Do these first:** [web-04](web-04-fingerprinted-assets-and-immutable-caching.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [perf-07](perf-07-sw-font-precache.md)
