import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'
import { stampAssetVersion, stampShellVersion } from '../../../scripts/asset-version.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

section('asset versioning — stampAssetVersion')

await test('stamps both bundled entry assets', () => {
    const html = '<link rel="stylesheet" href="js/app.css">\n<script type="module" src="js/app.js"></script>'
    const out = stampAssetVersion(html, '2.0.1')
    assert(out.includes('href="js/app.css?v=2.0.1"'), 'stylesheet is versioned')
    assert(out.includes('src="js/app.js?v=2.0.1"'), 'script is versioned')
})

await test('leaves unrelated references untouched', () => {
    const html = [
        '<link rel="stylesheet" href="fonts/inter/inter-google.css">',
        '<script defer src="https://um.example.com/script.js"></script>',
        '<link rel="manifest" href="site.webmanifest">',
        '<script type="module" src="js/app.js"></script>',
    ].join('\n')
    const out = stampAssetVersion(html, '1.2.3')
    assert(out.includes('href="fonts/inter/inter-google.css"'), 'font css untouched')
    assert(out.includes('src="https://um.example.com/script.js"'), 'analytics untouched')
    assert(out.includes('href="site.webmanifest"'), 'manifest untouched')
    assert(out.includes('src="js/app.js?v=1.2.3"'), 'app script stamped')
})

await test('replaces an existing version instead of appending', () => {
    const html = '<link href="js/app.css?v=1.0.0"><script src="js/app.js?v=1.0.0"></script>'
    const out = stampAssetVersion(html, '2.0.0')
    assert(out.includes('href="js/app.css?v=2.0.0"'), 'css upgraded')
    assert(out.includes('src="js/app.js?v=2.0.0"'), 'js upgraded')
    assert(!out.includes('1.0.0'), 'no stale version remains')
    assertEqual(out.match(/\?v=/g)?.length, 2, 'exactly one query per asset')
})

section('asset versioning — stampShellVersion')

await test('stamps only the app shell entries', () => {
    const sw = [
        "const APP_SHELL = [",
        "  './',",
        "  './index.html',",
        "  './version.json',",
        "  './js/app.css',",
        "  './site.webmanifest',",
        "  './js/app.js'",
        "]",
    ].join('\n')
    const out = stampShellVersion(sw, '3.1.4')
    assert(out.includes("'./js/app.css?v=3.1.4'"), 'css entry versioned')
    assert(out.includes("'./js/app.js?v=3.1.4'"), 'js entry versioned')
    assert(out.includes("'./index.html'"), 'index.html entry untouched')
    assert(out.includes("'./version.json'"), 'version.json entry untouched')
    assert(out.includes("'./site.webmanifest'"), 'manifest entry untouched')
})

await test('upgrades an already versioned shell', () => {
    const out = stampShellVersion("const APP_SHELL = ['./js/app.js?v=1.0.0']", '2.0.0')
    assertEqual(out, "const APP_SHELL = ['./js/app.js?v=2.0.0']", 'version replaced')
})

section('asset versioning — real build inputs')

// These two cases are the regression guard that matters: they fail the moment
// the shell markup or the sw.js APP_SHELL stops matching the patterns, which is
// exactly how un-versioned (and therefore cache-unsafe) assets would ship.
await test('the real index.html is stamped for both assets', () => {
    const html = readFileSync(path.join(ROOT, 'source', 'index.html'), 'utf8')
    const out = stampAssetVersion(html, '9.9.9')
    assert(out !== html, 'index.html contains stampable asset references')
    assert(out.includes('js/app.css?v=9.9.9'), 'real css reference stamped')
    assert(out.includes('js/app.js?v=9.9.9'), 'real js reference stamped')
})

await test('the real sw.js APP_SHELL is stamped for both assets', () => {
    const sw = readFileSync(path.join(ROOT, 'source', 'sw.js'), 'utf8')
    const out = stampShellVersion(sw, '9.9.9')
    assert(out !== sw, 'sw.js APP_SHELL contains stampable entries')
    assert(out.includes("'./js/app.css?v=9.9.9'"), 'real css shell entry stamped')
    assert(out.includes("'./js/app.js?v=9.9.9'"), 'real js shell entry stamped')
})
