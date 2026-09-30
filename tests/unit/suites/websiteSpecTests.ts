import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

// Guards the files and tokens added to follow https://specification.website.
// These are static artifacts (robots/sitemap/well-known/pages/edge headers), so
// the contract is pinned at the source level rather than through a browser.

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

section('Website Specification — crawl and discovery files')

await test('robots.txt has a policy, a Content-Signal and a sitemap reference', () => {
    const robots = read('source/robots.txt')
    assert(/^User-Agent:\s*\*/m.test(robots), 'robots.txt needs a User-Agent group')
    assert(/^Allow:\s*\//m.test(robots), 'robots.txt should allow crawling')
    assert(/^Content-Signal:/m.test(robots), 'robots.txt should declare Content-Signal directives')
    assert(/^Sitemap:\s*https:\/\/virgulas\.com\/sitemap\.xml$/m.test(robots), 'robots.txt should reference the sitemap')
})

await test('sitemap.xml lists the canonical home URL', () => {
    const sitemap = read('source/sitemap.xml')
    assert(sitemap.startsWith('<?xml'), 'sitemap.xml must be an XML document')
    assert(sitemap.includes('<loc>https://virgulas.com/</loc>'), 'sitemap.xml must list the home page')
})

await test('llms.txt exists and points at the specification', () => {
    const llms = read('source/llms.txt')
    assert(llms.startsWith('# '), 'llms.txt should start with an H1')
    assert(llms.includes('https://specification.website'), 'llms.txt should note the followed specification')
})

await test('well-known security.txt and gpc.json are present and valid', () => {
    const security = read('source/.well-known/security.txt')
    assert(/^Contact:/m.test(security), 'security.txt needs a Contact field')
    assert(/^Expires:/m.test(security), 'security.txt needs an Expires field')
    assert(/^Canonical:\s*https:\/\/virgulas\.com\/\.well-known\/security\.txt$/m.test(security), 'security.txt needs a canonical URL')

    const gpc = JSON.parse(read('source/.well-known/gpc.json'))
    assertEqual(gpc.gpc, true, 'gpc.json must declare "gpc": true')
})

section('Website Specification — required pages and icons')

await test('privacy policy page exists with an h1, canonical and a back link', () => {
    const privacy = read('source/privacy.html')
    assert(/<h1[^>]*>[\s\S]*Privacy[\s\S]*<\/h1>/.test(privacy), 'privacy page needs an <h1>Privacy')
    assert(privacy.includes('rel="canonical"'), 'privacy page needs a canonical URL')
    assert(privacy.includes('href="/"'), 'privacy page needs a link back to the app')
})

await test('the specification attribution lives in the contributor docs, not the app UI', () => {
    assert(read('README.md').includes('https://specification.website'), 'README should note the followed specification')
    assert(read('AGENTS.md').includes('https://specification.website'), 'AGENTS.md should note the followed specification')
    assert(
        !read('source/js/app.ts').includes('specification.website'),
        'the Options popup should not carry the specification attribution'
    )
    assert(
        !read('source/privacy.html').includes('specification.website'),
        'the privacy page should not carry the specification attribution'
    )
})

await test('custom 404 page exists and is noindex', () => {
    const notFound = read('source/404.html')
    assert(notFound.includes('404'), '404 page should name the error')
    assert(/name="robots"\s+content="noindex"/.test(notFound), '404 page should be noindex')
    assert(notFound.includes('href="/"'), '404 page should offer a way back to the app')
})

await test('a root favicon is shipped for browsers that guess /favicon.ico', () => {
    assert(existsSync(path.join(ROOT, 'source/favicon.ico')), 'source/favicon.ico must exist')
    assert(existsSync(path.join(ROOT, 'source/favicon.svg')), 'source/favicon.svg must exist')
})

section('Website Specification — document head foundations')

await test('the head carries canonical, Open Graph, colour-scheme and theme-colour', () => {
    const html = read('source/index.html')
    assert(html.includes('rel="canonical"'), 'canonical link is required')
    assert(html.includes('property="og:title"'), 'Open Graph title is required')
    assert(html.includes('name="color-scheme"'), 'color-scheme meta is required')
    const themeColors = html.match(/name="theme-color"/g) || []
    assertEqual(themeColors.length, 2, 'one theme-color per light/dark scheme')
    assert(html.includes('rel="preload"'), 'the critical font should be preloaded')
})

await test('structured data and a skip link are present', () => {
    const html = read('source/index.html')
    assert(html.includes('application/ld+json'), 'JSON-LD structured data is required')
    assert(html.includes('class="skip-link" href="#main-content"'), 'a skip link to #main-content is required')
    assert(html.includes('visually-hidden">Virgulas'), 'the page needs one <h1>')
})

await test('a no-JavaScript fallback is present instead of a stuck splash', () => {
    const html = read('source/index.html')
    assert(html.includes('<noscript>'), 'index.html needs a <noscript> fallback')
    assert(html.includes('noscript-fallback'), 'the fallback needs its styled container')
    assert(html.includes('#splash { display: none; }'), 'the fallback must hide the static splash')
    const base = read('source/css/base.css')
    assert(/\.noscript-fallback\s*\{/.test(base), 'the fallback container needs styling')
})

section('Website Specification — accessibility contract')

await test('form errors are announced and associated with their input', () => {
    const app = read('source/js/app.ts')
    assert(app.includes('id="auth-unlock-error" role="alert"'), 'unlock error needs an id and role="alert"')
    assert(app.includes("'auth-unlock-error'"), 'the passphrase input must reference the error')
    assert(app.includes('aria-invalid='), 'invalid inputs must be marked with aria-invalid')
    assert(app.includes('role="status"'), 'confirmations should be announced as status')
})

await test('the shell exposes main and contentinfo landmarks', () => {
    const app = read('source/js/app.ts')
    const ui = read('source/js/ui.ts')
    assert(app.includes('<main class="main-content" id="main-content"'), 'the document body needs a <main> landmark')
    assert(app.includes('inert='), 'background content should be inert while a modal is open')
    assert(ui.includes('role="contentinfo"'), 'the status toolbar should be a contentinfo landmark')
})

await test('contrast, forced colours and the skip-link style are defined', () => {
    const base = read('source/css/base.css')
    assert(/forced-colors:\s*active/.test(base), 'forced-colours support is required')
    assert(!base.includes('--color-text-faint: #aaa79f'), 'the low-contrast light faint token must be replaced')
    assert(!base.includes('--color-text-faint: #605d58'), 'the low-contrast dark faint token must be replaced')
    const shell = read('source/css/shell.css')
    assert(/\.skip-link\s*\{/.test(shell), 'the skip link needs styling')
})

section('Website Specification — edge headers')

await test('the Cloudflare helper sets every required response header', () => {
    const script = read('scripts/cloudflare-headers.mjs')
    for (const header of [
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'Content-Security-Policy',
        'X-Frame-Options',
        'Referrer-Policy',
        'Permissions-Policy'
    ]) {
        assert(script.includes(header), `edge headers must set ${header}`)
    }
    assert(script.includes("frame-ancestors 'none'"), 'CSP frame-ancestors must be set at the edge')
    assert(script.includes('always_use_https'), 'plain HTTP must redirect to HTTPS')
    assert(script.includes('Link'), 'the Link discovery header should be advertised')
})

section('Website Specification — Pages deploy parity')

await test('the Pages artifact keeps dotfiles so /.well-known is served', () => {
    // upload-pages-artifact v4+ tars with `--exclude=.[^/]*`, which silently
    // drops /.well-known/security.txt and gpc.json from the deployed site even
    // though they are in dist/. The local static server does not mirror that, so
    // only this source-level check catches the regression before production.
    const ci = read('.github/workflows/ci.yml')
    assert(
        /uses:\s*actions\/upload-pages-artifact@[\w.-]+[\s\S]*?include-hidden-files:\s*true/.test(ci),
        'upload-pages-artifact must set include-hidden-files: true or /.well-known/* 404s'
    )
})
