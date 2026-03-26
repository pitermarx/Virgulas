export function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed')
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        const e = new Error(message || 'Assert equals failed')
        e.details = { expected, actual }
        throw e
    }
}

export function assertNotEqual(actual, expected, message) {
    if (actual === expected) {
        const e = new Error(message || 'Assert not equals failed')
        e.details = { actual, forbidden: expected }
        throw e
    }
}

export function summaryFromSections(sections) {
    let passed = 0
    let failed = 0
    for (const section of sections) {
        for (const test of section.tests) {
            if (test.ok) passed++
            else failed++
        }
    }
    return { passed, failed, total: passed + failed }
}

export function cloneSections(sections) {
    return sections.map(section => ({
        name: section.name,
        tests: section.tests.map(test => ({ ...test }))
    }))
}

export function createSyncSectionHarness(options = {}) {
    const sections = []
    let currentSection = null
    const beforeEach = options.beforeEach || (() => { })

    function section(name) {
        currentSection = { name, tests: [] }
        sections.push(currentSection)
    }

    function test(name, fn) {
        beforeEach()
        const entry = { name, ok: false, error: null, errorDetails: null }
        currentSection.tests.push(entry)

        try {
            fn()
            entry.ok = true
        } catch (e) {
            entry.error = e && e.message ? e.message : String(e)
            entry.errorDetails = e && e.details ? e.details : null
        }
    }

    return {
        sections,
        section,
        test,
        summary: () => summaryFromSections(sections)
    }
}

export function createAsyncSectionHarness(options = {}) {
    const sections = []
    let currentSection = null
    const beforeEach = options.beforeEach || (async () => { })
    const onProgress = options.onProgress || null

    function section(name) {
        currentSection = { name, tests: [] }
        sections.push(currentSection)
    }

    function emitProgress() {
        if (!onProgress) return
        onProgress({
            sections: cloneSections(sections),
            summary: summaryFromSections(sections)
        })
    }

    async function test(name, fn) {
        await beforeEach()
        const entry = { name, ok: false, error: null, errorDetails: null }
        currentSection.tests.push(entry)

        try {
            await fn()
            entry.ok = true
        } catch (e) {
            entry.error = e && e.message ? e.message : String(e)
            entry.errorDetails = e && e.details ? e.details : null
        }

        emitProgress()
    }

    return {
        sections,
        section,
        test,
        summary: () => summaryFromSections(sections)
    }
}

export async function streamCompletedSections(sourceSections, onProgress, batchSize = 10) {
    const progressive = sourceSections.map(section => ({ name: section.name, tests: [] }))
    let passed = 0
    let failed = 0
    let emitted = 0

    for (let i = 0; i < sourceSections.length; i++) {
        for (const testEntry of sourceSections[i].tests) {
            progressive[i].tests.push(testEntry)
            if (testEntry.ok) passed++
            else failed++

            if (onProgress) {
                onProgress({
                    sections: progressive.map(section => ({
                        name: section.name,
                        tests: section.tests.slice()
                    })),
                    summary: { passed, failed, total: passed + failed }
                })
            }

            emitted++
            if (emitted % batchSize === 0) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
        }
    }

    return {
        sections: progressive,
        summary: { passed, failed, total: passed + failed }
    }
}
