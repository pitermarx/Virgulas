import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, createAsyncSectionHarness } from '../testing.js'

// Guards the mobile viewport sizing fixed for the bottom status toolbar.
// A browser engine's dynamic viewport unit (`dvh`) tracks the mobile URL bar,
// while `vh` is the large viewport and hides the toolbar below the fold. No
// headless runner emulates the URL bar, so this pins the CSS contract directly.

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const readCss = (name: string) => readFileSync(path.join(ROOT, 'source/css', name), 'utf8')

section('Mobile viewport height')

await test('the main view uses dynamic viewport height with a vh fallback', () => {
    const css = readCss('views.css')
    assert(
        /\.main-view\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/s.test(css),
        '.main-view must declare 100vh then 100dvh so the status toolbar stays visible'
    )
})

await test('the app shell and root track the dynamic viewport', () => {
    const base = readCss('base.css')
    assert(
        /#app\s*\{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100dvh;/s.test(base),
        '#app must declare 100vh then 100dvh'
    )
    const shell = readCss('shell.css')
    assert(
        /\.app-shell\s*\{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100dvh;/s.test(shell),
        '.app-shell must declare 100vh then 100dvh'
    )
})

await test('fixed overlays track the dynamic viewport', () => {
    const base = readCss('base.css')
    assert(
        /#splash\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/s.test(base),
        '#splash must declare 100vh then 100dvh'
    )
    const outline = readCss('outline.css')
    assert(
        /\.modal-overlay\s*\{[^}]*height:\s*100vh;[^}]*height:\s*100dvh;/s.test(outline),
        '.modal-overlay must declare 100vh then 100dvh'
    )
})
