// Runs the legacy in-browser unit suites under `bun test`.
//
// The suites were written for a custom in-page harness that executes tests at
// import time and records pass/fail entries. Rather than rewrite every case,
// this file imports each suite (executing it), then replays each recorded
// result as a real `bun:test` case so failures are attributed per test and the
// process exit code is correct.
//
// Imports are dynamic and awaited one at a time: the suites share the `outline`
// singleton and Bun can interleave sibling modules that use top-level await,
// which would let one suite mutate another's document mid-test. Sequential
// imports guarantee each suite runs to completion in isolation.
import { describe, it } from 'bun:test'
import type { Section } from './testing.js'

function replay(suiteName: string, sections: Section[]): void {
    describe(suiteName, () => {
        for (const section of sections) {
            describe(section.name, () => {
                for (const t of section.tests) {
                    it(t.name, () => {
                        if (!t.ok) throw new Error(t.error ?? 'Test failed')
                    })
                }
            })
        }
    })
}

const outline = await import('./suites/outlineTests.js')
replay('outline', outline.sections)

const outlineExtra = await import('./suites/outlineExtraTests.js')
replay('outline extras', outlineExtra.sections)

const search = await import('./suites/searchTests.js')
replay('search helpers', search.sections)

const sync = await import('./suites/syncTests.js')
replay('sync', sync.sections)

const syncHelpers = await import('./suites/syncHelpersTests.js')
replay('sync helpers', syncHelpers.sections)

const meta = await import('./suites/metaTests.js')
replay('meta', meta.sections)

const tasks = await import('./suites/tasksTests.js')
replay('tasks', tasks.sections)

const markdown = await import('./suites/markdownTests.js')
replay('markdown', markdown.sections)

const inbox = await import('./suites/inboxTests.js')
replay('inbox', inbox.sections)

const utils = await import('./suites/utilsTests.js')
replay('utils', utils.sections)

const crypto2 = await import('./suites/crypto2Tests.js')
replay('crypto2', (await crypto2.runCrypto2Tests(undefined)).sections)

const shortcuts = await import('./suites/shortcutsTests.js')
replay('shortcuts', (await shortcuts.runShortcutsTests(undefined)).sections)

const csp = await import('./suites/cspTests.js')
replay('csp', csp.sections)

const assetVersion = await import('./suites/assetVersionTests.js')
replay('asset versioning', assetVersion.sections)

const staticPath = await import('./suites/staticPathTests.js')
replay('dev server path safety', staticPath.sections)

// Runs last: installs fake IndexedDB / WebAuthn globals.
const biometrics = await import('./suites/biometricsTests.js')
replay('biometrics', biometrics.sections)
