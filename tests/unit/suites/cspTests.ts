import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'
import {
    resolveSupabaseOrigin,
    extractDefaultSupabaseUrl,
    tightenConnectSrc
} from '../../../scripts/csp.js'

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const DEV_CSP_HTML = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self' https://*.supabase.co https://um.vps.pitermarx.com http://127.0.0.1:* http://localhost:*; object-src 'none'">`

section('CSP build helper — resolveSupabaseOrigin')

await test('prefers the CLI URL and strips any path', () => {
    assertEqual(
        resolveSupabaseOrigin({ cliUrl: 'https://abc.supabase.co/rest/v1/', appUrl: 'https://other.supabase.co' }),
        'https://abc.supabase.co',
        'cli url wins and is normalised to an origin'
    )
})

await test('builds an origin from a project ref', () => {
    assertEqual(resolveSupabaseOrigin({ envProject: 'abcdefghijkl' }), 'https://abcdefghijkl.supabase.co', 'ref')
})

await test('accepts a project value that is already a full URL', () => {
    assertEqual(resolveSupabaseOrigin({ envProject: 'https://x.supabase.co' }), 'https://x.supabase.co', 'full url')
})

await test('falls back to the app default', () => {
    assertEqual(resolveSupabaseOrigin({ appUrl: 'https://app.supabase.co/' }), 'https://app.supabase.co', 'app url')
})

await test('returns empty for missing or invalid input', () => {
    assertEqual(resolveSupabaseOrigin({}), '', 'nothing provided')
    assertEqual(resolveSupabaseOrigin({ cliUrl: 'not a url' }), '', 'invalid url')
})

section('CSP build helper — extractDefaultSupabaseUrl')

await test('reads the url from a DEFAULT_CONFIG literal', () => {
    const source = "const DEFAULT_CONFIG = { url: 'https://real.supabase.co', key: 'sb_publishable_x' }"
    assertEqual(extractDefaultSupabaseUrl(source), 'https://real.supabase.co', 'extracted')
})

await test('returns empty when the constant is absent', () => {
    assertEqual(extractDefaultSupabaseUrl('const other = 1'), '', 'absent')
})

section('CSP build helper — tightenConnectSrc')

await test('drops localhost and the wildcard and pins the real origin', () => {
    const out = tightenConnectSrc(DEV_CSP_HTML, 'https://real.supabase.co')
    assert(!out.includes('localhost'), 'no localhost')
    assert(!out.includes('127.0.0.1'), 'no loopback')
    assert(!out.includes('*.supabase.co'), 'no wildcard')
    assert(out.includes('https://real.supabase.co'), 'pinned origin present')
    assert(out.includes('https://um.vps.pitermarx.com'), 'analytics collector kept')
    assert(out.includes("'self'"), 'self kept')
})

await test('throws without a Supabase origin', () => {
    let threw = false
    try {
        tightenConnectSrc(DEV_CSP_HTML, '')
    } catch {
        threw = true
    }
    assert(threw, 'missing origin must throw rather than ship the dev policy')
})

await test('throws when the directive is missing', () => {
    let threw = false
    try {
        tightenConnectSrc('<meta>', 'https://real.supabase.co')
    } catch {
        threw = true
    }
    assert(threw, 'missing directive must throw')
})

await test('refuses a local Supabase origin', () => {
    let threw = false
    try {
        tightenConnectSrc(DEV_CSP_HTML, 'http://127.0.0.1:54321')
    } catch {
        threw = true
    }
    assert(threw, 'a local origin must never be pinned into a production CSP')
})

section('CSP production wiring')

await test('the real shell tightens without localhost or the wildcard', () => {
    const syncSource = readFileSync(path.join(ROOT, 'source/js/sync.ts'), 'utf8')
    const html = readFileSync(path.join(ROOT, 'source/index.html'), 'utf8')
    const origin = resolveSupabaseOrigin({ appUrl: extractDefaultSupabaseUrl(syncSource) })

    assert(!!origin, 'resolved a Supabase origin from the app source')
    const out = tightenConnectSrc(html, origin)
    assert(!out.includes('localhost') && !out.includes('127.0.0.1'), 'no local sources in production CSP')
    assert(!out.includes('*.supabase.co'), 'no wildcard in production CSP')
    assert(out.includes(origin), 'pinned origin present')
    assert(out.includes('https://um.vps.pitermarx.com'), 'analytics collector kept')
})
