#!/usr/bin/env bun
// Build the browser app with Bun's bundler.
//   - copies source/ -> dist/ (assets, index.html, sw.js)
//   - bundles source/js/app.ts (and its node_modules deps) into dist/js/app.js
//   - bundles source/css/*.css into dist/js/app.css
//   - stamps the app version into dist/index.html and dist/version.json
//
// Usage: bun scripts/build-bun.mjs [sourceDir] [outDir] [--version <semver>]
//
// Options:
//   --local                keep the development CSP connect-src (localhost +
//                          *.supabase.co). Omit for production builds, which pin
//                          the concrete Supabase origin instead.
//   --supabase-url <url>   override the Supabase origin pinned into the CSP
//   --test-hooks           enable the __TEST_HOOKS__ seam (Playwright only)
//   --sourcemap[=<mode>]   none | linked (default) | inline | external
//   --no-sourcemap         shorthand for --sourcemap=none
//   --minify / --no-minify override the minify default (minified)
//
// Note: Bun's bundler only emits JS source maps, not CSS ones.

import { cp, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractDefaultSupabaseUrl, resolveSupabaseOrigin, tightenConnectSrc } from './csp.ts'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const versionFlagIndex = args.indexOf('--version')
const versionFlag = versionFlagIndex >= 0 ? args[versionFlagIndex + 1] : undefined
// Test-only build: enables the __TEST_HOOKS__ seam (window.supabase) used by the
// Playwright suites. Production builds must leave it off so shipped code never
// reads a browser global for the Supabase client.
const testHooks = args.includes('--test-hooks')
// Local development build: keep the permissive CSP connect-src (localhost and the
// Supabase wildcard). Production builds tighten it to one concrete origin.
const isLocalBuild = args.includes('--local')
const supabaseUrlIndex = args.indexOf('--supabase-url')
const supabaseUrlFlag = supabaseUrlIndex >= 0 ? args[supabaseUrlIndex + 1] : ''

const sourcemapArg = args.find((a) => a.startsWith('--sourcemap'))
const SOURCEMAP_MODES = new Set(['none', 'linked', 'inline', 'external'])
const sourcemap = args.includes('--no-sourcemap')
    ? 'none'
    : sourcemapArg
        ? (sourcemapArg.includes('=') ? sourcemapArg.split('=')[1] : 'linked')
        : 'linked'
if (!SOURCEMAP_MODES.has(sourcemap)) {
    console.error(`Unknown sourcemap mode "${sourcemap}". Use one of: ${[...SOURCEMAP_MODES].join(', ')}`)
    process.exit(1)
}
const minify = !args.includes('--no-minify')

const srcDir = path.resolve(positional[0] || 'source')
const outDir = path.resolve(positional[1] || 'dist')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
await cp(srcDir, outDir, { recursive: true })

const entry = path.join(srcDir, 'js', 'app.ts')
const build = await Bun.build({
    entrypoints: [entry],
    outdir: path.join(outDir, 'js'),
    target: 'browser',
    minify,
    sourcemap,
    // Code splitting keeps the on-demand Supabase chunk out of the initial
    // bundle (see sync.ts). Without it the dynamic import is inlined.
    splitting: true,
    define: { 'process.env.NODE_ENV': '"production"', '__TEST_HOOKS__': testHooks ? 'true' : 'false' },
})

if (!build.success) {
    for (const log of build.logs) console.error(log)
    process.exit(1)
}

// ── Prune TypeScript sources from the output ────────────────────────────────
// The build copies source/ first; only the bundled JS/CSS should ship.
const jsOutDir = path.join(outDir, 'js')
for (const file of await readdir(jsOutDir)) {
    if (file.endsWith('.ts')) await unlink(path.join(jsOutDir, file))
}
// The modular CSS sources are bundled into js/app.css; don't ship the originals.
await rm(path.join(outDir, 'css'), { recursive: true, force: true })

// ── App version stamping ─────────────────────────────────────────────────────
const pkg = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'))
const version = versionFlag || pkg.version || '0.0.0'
const sha = process.env.GITHUB_SHA || ''

const indexPath = path.join(outDir, 'index.html')
let html = await readFile(indexPath, 'utf8')
const metaRe = /<meta\s+name="app-version"\s+content="[^"]*"\s*\/?>/
if (!metaRe.test(html)) {
    throw new Error(`Missing app-version meta tag in ${indexPath}`)
}
html = html.replace(metaRe, `<meta name="app-version" content="${version}">`)

// Pin the CSP to the real Supabase origin for production builds. Local builds keep
// the development policy so `bun run dev` can talk to a local Supabase instance.
if (!isLocalBuild) {
    const syncSource = await readFile(path.join(srcDir, 'js', 'sync.ts'), 'utf8')
    const supabaseOrigin = resolveSupabaseOrigin({
        cliUrl: supabaseUrlFlag,
        envUrl: process.env.SUPABASE_URL,
        envProject: process.env.SUPABASE_PROJECT,
        appUrl: extractDefaultSupabaseUrl(syncSource),
    })
    html = tightenConnectSrc(html, supabaseOrigin)
}
await writeFile(indexPath, html)

await writeFile(
    path.join(outDir, 'version.json'),
    JSON.stringify({ version, sha, generatedAt: new Date().toISOString() }, null, 2) + '\n',
)

const outputs = await Promise.all(
    build.outputs.map(async (o) => `${path.relative(outDir, o.path)} ${(o.size / 1024).toFixed(1)} KB`),
)
console.log(`Built ${build.outputs.length} output(s) in ${outDir} (minify: ${minify}, sourcemap: ${sourcemap}):`)
for (const line of outputs) console.log(`  ${line}`)
console.log(`Stamped version ${version}${testHooks ? ' (test hooks enabled)' : ''} (csp: ${isLocalBuild ? 'local' : 'production'})`)
