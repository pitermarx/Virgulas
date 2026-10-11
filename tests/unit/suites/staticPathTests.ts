import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'
import { resolveStaticPath } from '../../../scripts/static-path.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve('/virtual/app/dist')

section('dev server — resolveStaticPath')

await test('resolves a nested file inside the root', () => {
    assertEqual(resolveStaticPath(ROOT, '/js/app.js'), path.join(ROOT, 'js', 'app.js'), 'nested file')
    assertEqual(resolveStaticPath(ROOT, '/fonts/inter/inter-latin.woff2'), path.join(ROOT, 'fonts', 'inter', 'inter-latin.woff2'), 'nested asset')
})

await test('resolves the root itself without escaping', () => {
    assertEqual(resolveStaticPath(ROOT, '/'), ROOT, 'root path')
})

await test('rejects parent traversal', () => {
    assertEqual(resolveStaticPath(ROOT, '/../secret.txt'), null, 'dot-dot segment')
    assertEqual(resolveStaticPath(ROOT, '/js/../../secret.txt'), null, 'nested dot-dot')
})

await test('rejects traversal into a sibling that shares the root prefix', () => {
    assertEqual(resolveStaticPath(ROOT, '/../dist-secret/x.txt'), null, 'prefix bypass')
})

await test('rejects NUL bytes', () => {
    assertEqual(resolveStaticPath(ROOT, '/js/app\0.js'), null, 'NUL byte')
})

await test('keeps percent-encoded characters inside the root', () => {
    // serve-bun decodes before calling this; a literal "%2e" is just a filename.
    const resolved = resolveStaticPath(ROOT, '/%2e%2e%2fsecret.txt')
    assert(resolved !== null && resolved.startsWith(ROOT + path.sep), 'encoded name stays inside the root')
})

section('service worker navigation caching')

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const swSource = readFileSync(path.join(SOURCE_ROOT, 'source/sw.js'), 'utf8')

// Scope the assertions to the navigation handler only: cacheFirst and
// staleWhileRevalidate legitimately key static assets under the request URL,
// but navigations must never be.
const navStart = swSource.indexOf('async function networkFirstNavigation')
const navEnd = swSource.indexOf('async function cacheFirst')
assert(navStart !== -1 && navEnd > navStart, 'sw.js should define networkFirstNavigation before cacheFirst')
const navHandler = swSource.slice(navStart, navEnd)

await test('declares the canonical shell cache key', () => {
    // A quick-capture visit (`/?quick-add=…`) or a `#<nodeId>` zoom link would
    // otherwise pin the captured text or node id into Cache Storage in plaintext.
    assert(/const SHELL_CACHE_KEY\s*=\s*'\.\/index\.html'/.test(swSource), 'navigation cache key must be the canonical ./index.html')
})

await test('caches navigations under the shell key, never the requested URL', () => {
    assert(/cache\.put\(SHELL_CACHE_KEY/.test(navHandler), 'navigations must be cached under SHELL_CACHE_KEY')
    assert(!/cache\.put\(request/.test(navHandler), 'navigations must not be cached under the requested URL')
})

await test('caches only successful navigation responses', () => {
    // A 404 or 5xx must not become the pinned offline shell.
    assert(/if \(response\.ok\) \{[\s\S]*?cache\.put\(SHELL_CACHE_KEY/.test(navHandler), 'navigation cache.put must be gated on response.ok')
})

await test('offers no URL-keyed navigation fallback', () => {
    assert(!/caches\.match\(request\)/.test(navHandler), 'the offline navigation fallback must match the shell key, not the request')
    assert(/caches\.match\(SHELL_CACHE_KEY\)/.test(navHandler), 'the offline navigation fallback must read SHELL_CACHE_KEY')
})
