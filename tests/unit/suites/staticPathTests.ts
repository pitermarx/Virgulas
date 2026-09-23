import path from 'node:path'
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
