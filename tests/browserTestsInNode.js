#!/usr/bin/env node
// Node.js harness to run source/js/outlineTests.js
// Sets up browser API shims and runs the existing tests

// ── browser API shims ────────────────────────────────────────────────────────
class URLSearchParams {
    constructor(str) {
        this.params = {}
        if (!str) return
        if (str.startsWith('?')) str = str.slice(1)
        for (const p of str.split('&')) {
            const [k, v] = p.split('=')
            if (k) this.params[k] = decodeURIComponent(v || '')
        }
    }
    get(k) { return this.params[k] ?? null }
}

globalThis.URLSearchParams = URLSearchParams
globalThis.window = {
    location: { search: '' },
    crypto: typeof globalThis.crypto === 'object' ? globalThis.crypto : (await import('node:crypto')).webcrypto,
}
globalThis.document = { body: { classList: { add() { } } } }

// ── run outline tests ────────────────────────────────────────────────────────
const { sections, summary, streamOutlineTests } = await import('../source/js/outlineTests.js')

console.log('Running outline.js tests in Node.js...\n')

await streamOutlineTests(({ summary: s }) => {
    const pct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0
    process.stdout.write(`\r${s.passed}/${s.total} passed (${pct}%)`)
})

const os = summary()
process.stdout.write(`\rOutline: ${os.total}/${os.total} passed\n\n`)

// ── run crypto2 tests ───────────────────────────────────────────────────────
const { runCrypto2Tests } = await import('../source/js/crypto2Tests.js')

console.log('Running crypto2.js tests in Node.js...\n')

const cr = await runCrypto2Tests(({ summary: s }) => {
    const pct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0
    process.stdout.write(`\r${s.passed}/${s.total} passed (${pct}%)`)
})

process.stdout.write(`\n\nCrypto2: ${cr.summary.total}/${cr.summary.total} passed\n\n`)

// ── run shortcuts tests ─────────────────────────────────────────────────────
const { runShortcutsTests } = await import('../source/js/shortcutsTests.js')

console.log('Running shortcuts.js tests in Node.js...\n')

const sr = await runShortcutsTests(({ summary: s }) => {
    const pct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0
    process.stdout.write(`\r${s.passed}/${s.total} passed (${pct}%)`)
})

process.stdout.write(`\n\nShortcuts: ${sr.summary.total}/${sr.summary.total} passed\n\n`)

// ── summary ──────────────────────────────────────────────────────────────────
const totalAll = os.total + cr.summary.total + sr.summary.total
const passedAll = os.passed + cr.summary.passed + sr.summary.passed
const failedAll = os.failed + cr.summary.failed + sr.summary.failed

console.log('─'.repeat(50))
console.log(`Total: ${totalAll} | Passed: ${passedAll} | Failed: ${failedAll}`)

if (failedAll > 0) {
    for (const sec of sections) {
        for (const t of sec.tests) {
            if (!t.ok) process.stderr.write(`  [${sec.name}] ${t.name}: ${t.error}\n`)
        }
    }
    for (const sec of cr.sections) {
        for (const t of sec.tests) {
            if (!t.ok) process.stderr.write(`  [${sec.name}] ${t.name}: ${t.error}\n`)
        }
    }
    for (const sec of sr.sections) {
        for (const t of sec.tests) {
            if (!t.ok) process.stderr.write(`  [${sec.name}] ${t.name}: ${t.error}\n`)
        }
    }
} else {
    // Use a more forceful exit to skip WebStream cleanup in Node.js 25
    process.stdout.write('All tests passed!\n')
}
// process exitCode signals exit to Node.js runtime
process.stdout.on('drain', () => process.exit(failedAll > 0 ? 1 : 0))
process.exit(failedAll > 0 ? 1 : 0)
