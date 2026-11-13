# Fingerprinted assets and immutable caching

- **Priority:** P4 (Website Specification, optional tier)
- **Type:** build and caching
- **Spec impact:** none; changes build output and the service worker shell list

## The question: is this respectful of users' devices with a weekly release?

Yes, and it is lighter on the device than today. With hashed file names a user downloads the new bundle (about 207 KB JavaScript, 39 KB CSS, plus the Supabase chunk for Remote users) once per release, so about once a week, and nothing in between. Today the file names never change, so the browser and the service worker keep revalidating `app.js` and `app.css` on visits. Old versions are not kept on the device longer than a release cycle if the service worker prunes entries that are not in the current manifest (the activate-time prune from the sec-03 work already does this). The one cost is a short overlap where old and new files coexist in the cache.

## What it fixes

- perf-05: a cached `app.js` that imports a hashed chunk that no longer exists on the server. With a manifest, the service worker can precache every hashed file together, so all cached files belong to one release.
- Revalidation traffic: today GitHub Pages serves `Cache-Control: max-age=600` and the service worker revalidates in the background on every visit.

## Suggested approach

1. Build: use Bun's `naming` option (for example `[dir]/[name]-[hash].[ext]` for entries and chunks) and rewrite the `<script>` and `<link>` URLs in `dist/index.html` from the build result. Emit a small `asset-manifest.json`.
2. Service worker: generate the `APP_SHELL` list from the manifest at build time instead of the hand-kept list and the hash bump script (`bump-sw-caches.mjs`), and delete cache entries that are not in the manifest on activate.
3. Headers: add `Cache-Control: public, max-age=31536000, immutable` for hashed paths through the Cloudflare response-header ruleset (`cloudflare-headers.mjs`); GitHub Pages cannot set per-file headers. Keep `index.html`, `sw.js`, `version.json` and `site.webmanifest` on `no-cache` or a short TTL.
4. Fonts and icons are already versioned by cache name; hash them too if the cache-name bumping is to go away.
5. Keep source maps out of production, as now.

## Open questions

Whether Cloudflare is the layer that should own caching headers, since a header-only change would also benefit unhashed fonts and media.

## Tests

Build test: output names include a hash and `index.html` references them; unit test the manifest-to-shell generation; Playwright: after a simulated deploy the cache holds only the new release's files.

<!-- roadmap -->
## Roadmap position

- **Phase:** [8 — Delivery, platform and housekeeping](README.md#phase-8)
- **Size:** M
- **Do these first:** [ci-03](ci-03-tests-not-run-against-production-bundle.md)
- **Unblocks:** [perf-05](perf-05-sw-stale-chunk-after-deploy.md)
- **Its decision changes how these are built:** [perf-07](perf-07-sw-font-precache.md)
- **Shaped by:** —
- **Related:** —
