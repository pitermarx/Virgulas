import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual } from '../testing.js'
import { resolveStaticPath } from '../../../scripts/static-path.js'

const ROOT = path.resolve('/virtual/app/dist')

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const swSource = readFileSync(path.join(SOURCE_ROOT, 'source/sw.js'), 'utf8')

// Scope the assertions to the navigation handler only: cacheFirst and
// staleWhileRevalidate legitimately key static assets under the request URL,
// but navigations must never be.
const navStart = swSource.indexOf('async function networkFirstNavigation')
const navEnd = swSource.indexOf('async function cacheFirst')
assert(navStart !== -1 && navEnd > navStart, 'sw.js should define networkFirstNavigation before cacheFirst')
const navHandler = swSource.slice(navStart, navEnd)

const fetchHandler = swSource.slice(
    swSource.indexOf("self.addEventListener('fetch'"),
    swSource.indexOf('// Navigations are cached under this one canonical key')
)
const swrStart = swSource.indexOf('async function staleWhileRevalidate')
const swrBody = swSource.slice(swrStart)

describe('dev server — resolveStaticPath', () => {

  it('resolves a nested file inside the root', () => {
      assertEqual(resolveStaticPath(ROOT, '/js/app.js'), path.join(ROOT, 'js', 'app.js'), 'nested file')
      assertEqual(resolveStaticPath(ROOT, '/fonts/inter/inter-latin.woff2'), path.join(ROOT, 'fonts', 'inter', 'inter-latin.woff2'), 'nested asset')
  })

  it('resolves the root itself without escaping', () => {
      assertEqual(resolveStaticPath(ROOT, '/'), ROOT, 'root path')
  })

  it('rejects parent traversal', () => {
      assertEqual(resolveStaticPath(ROOT, '/../secret.txt'), null, 'dot-dot segment')
      assertEqual(resolveStaticPath(ROOT, '/js/../../secret.txt'), null, 'nested dot-dot')
  })

  it('rejects traversal into a sibling that shares the root prefix', () => {
      assertEqual(resolveStaticPath(ROOT, '/../dist-secret/x.txt'), null, 'prefix bypass')
  })

  it('rejects NUL bytes', () => {
      assertEqual(resolveStaticPath(ROOT, '/js/app\0.js'), null, 'NUL byte')
  })

  it('keeps percent-encoded characters inside the root', () => {
      // serve-bun decodes before calling this; a literal "%2e" is just a filename.
      const resolved = resolveStaticPath(ROOT, '/%2e%2e%2fsecret.txt')
      assert(resolved !== null && resolved.startsWith(ROOT + path.sep), 'encoded name stays inside the root')
  })
})

describe('service worker navigation caching', () => {

  it('declares the canonical shell cache key', () => {
      // A quick-capture visit (`/?quick-add=…`) or a `#<nodeId>` zoom link would
      // otherwise pin the captured text or node id into Cache Storage in plaintext.
      assert(/const SHELL_CACHE_KEY\s*=\s*'\.\/index\.html'/.test(swSource), 'navigation cache key must be the canonical ./index.html')
  })

  it('caches navigations under the shell key, never the requested URL', () => {
      assert(/cache\.put\(SHELL_CACHE_KEY/.test(navHandler), 'navigations must be cached under SHELL_CACHE_KEY')
      assert(!/cache\.put\(request/.test(navHandler), 'navigations must not be cached under the requested URL')
  })

  it('caches only successful shell navigations', () => {
      // A 404/5xx must not become the pinned offline shell, and only the app
      // shell navigations (/ , /index.html) are cached — /privacy.html must not
      // overwrite the shell. The gate is `response.ok && isShellNavigation(...)`.
      assert(/if \(response\.ok && isShellNavigation\(pathname\)\)/.test(navHandler), 'navigation cache.put must be gated on response.ok AND isShellNavigation')
      assert(/cache\.put\(SHELL_CACHE_KEY/.test(navHandler), 'shell navigations are cached under SHELL_CACHE_KEY')
  })

  it('offers no URL-keyed navigation fallback', () => {
      assert(!/caches\.match\(request\)/.test(navHandler), 'the offline navigation fallback must match the shell key, not the request')
      assert(/caches\.match\(SHELL_CACHE_KEY\)/.test(navHandler), 'the offline navigation fallback must read SHELL_CACHE_KEY')
  })
})

describe('service worker cache hygiene (perf-06)', () => {

  it('passes the background revalidation to event.waitUntil before any await', () => {
      // perf-06: a bare background fetch could be cut short when the browser stops
      // the worker. The revalidation must be held by event.waitUntil(), called
      // synchronously (before the first `await`) while the fetch event dispatches.
      // Strip comment lines first so the prose (which mentions both tokens) cannot
      // satisfy the index checks.
      const swrCode = swrBody
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n')
      const waitUntilIdx = swrCode.indexOf('event.waitUntil(')
      const firstAwaitIdx = swrCode.indexOf('await ')
      assert(waitUntilIdx !== -1, 'staleWhileRevalidate must call event.waitUntil')
      assert(firstAwaitIdx !== -1, 'staleWhileRevalidate still awaits the cache')
      assert(waitUntilIdx < firstAwaitIdx, 'event.waitUntil must be called before the first await (synchronous dispatch)')
  })

  it('does not use a stale-while-revalidate catch-all (passthrough default)', () => {
      // Everything the app does not explicitly allowlist must pass through rather
      // than be cached under its URL by a catch-all SWR.
      assert(!/event\.respondWith\(staleWhileRevalidate\(request\)\)/.test(swSource), 'there must be no unguarded staleWhileRevalidate catch-all')
      assert(/Everything else passes straight through/.test(fetchHandler), 'the fetch handler must fall through to a passthrough for unknown paths')
  })

  it('caches version.json and intro.vmd network-first', () => {
      // perf-06: these were stale-while-revalidate like the bundle, so a version
      // display could lag a visit.
      assert(/path\.endsWith\('\/version\.json'\) \|\| path\.endsWith\('\/intro\.vmd'\)/.test(fetchHandler), 'version.json and intro.vmd must be routed')
      assert(/event\.respondWith\(networkFirst\(request, APP_CACHE\)\)/.test(fetchHandler), 'version.json and intro.vmd must use network-first')
  })

  it('prunes non-allowlisted entries on activate', () => {
      // perf-06: old hashed chunks / stray cached responses must not linger until
      // the next version bump.
      assert(/async function pruneStaleEntries\(\)/.test(swSource), 'an activate-time prune must exist')
      assert(/\.then\(\(\) => pruneStaleEntries\(\)\)/.test(swSource), 'activate must invoke pruneStaleEntries')
      assert(/isCacheablePath/.test(swSource), 'the prune must consult the cacheable-path allowlist')
  })

  it('routes the Supabase chunk cache-first for offline Remote mode', () => {
      // The content-hashed chunk cannot be precached (its name changes per build)
      // but Remote mode needs it offline, so it must still be cached on first use.
      assert(/isChunkPath\(path\)/.test(fetchHandler), 'chunk paths must be matched')
      assert(/event\.respondWith\(cacheFirst\(request, APP_CACHE\)\)/.test(fetchHandler), 'chunks must be cache-first into APP_CACHE')
  })
})
