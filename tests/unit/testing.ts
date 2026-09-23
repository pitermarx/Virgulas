export interface TestEntry {
    name: string
    ok: boolean
    error: string | null
    errorDetails: unknown
}

export interface Section {
    name: string
    tests: TestEntry[]
}

export interface Summary {
    passed: number
    failed: number
    total: number
}

export interface Progress {
    sections: Section[]
    summary: Summary
}

export interface AssertError extends Error {
    details?: unknown
}

export function assert(condition: unknown, message?: string): asserts condition {
    if (!condition) throw new Error(message || 'Assertion failed')
}

export function assertEqual(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) {
        const e = new Error(message || 'Assert equals failed') as AssertError
        e.details = { expected, actual }
        throw e
    }
}

export function assertNotEqual(actual: unknown, expected: unknown, message?: string): void {
    if (actual === expected) {
        const e = new Error(message || 'Assert not equals failed') as AssertError
        e.details = { actual, forbidden: expected }
        throw e
    }
}

export function summaryFromSections(sections: Section[]): Summary {
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

export function cloneSections(sections: Section[]): Section[] {
    return sections.map(section => ({
        name: section.name,
        tests: section.tests.map(test => ({ ...test }))
    }))
}

export interface Harness {
    sections: Section[]
    section(name: string): void
    test(name: string, fn: () => unknown | Promise<unknown>): Promise<void>
    summary(): Summary
}

export function createAsyncSectionHarness(options: {
    beforeEach?: () => unknown | Promise<unknown>
    onProgress?: ((progress: Progress) => void) | null
} = {}): Harness {
    const sections: Section[] = []
    let currentSection: Section | null = null
    const beforeEach = options.beforeEach || (async () => { })
    const onProgress = options.onProgress || null

    function section(name: string): void {
        currentSection = { name, tests: [] }
        sections.push(currentSection)
    }

    function emitProgress(): void {
        if (!onProgress) return
        onProgress({
            sections: cloneSections(sections),
            summary: summaryFromSections(sections)
        })
    }

    async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
        await beforeEach()
        const entry: TestEntry = { name, ok: false, error: null, errorDetails: null }
        if (!currentSection) {
            throw new Error(`No active section when registering test "${name}"`)
        }
        currentSection.tests.push(entry)

        try {
            await (fn() || Promise.resolve())
            entry.ok = true
        } catch (e) {
            const err = e as AssertError
            entry.error = err && err.message ? err.message : String(e)
            entry.errorDetails = err && err.details ? err.details : null
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

export async function streamCompletedSections(
    sourceSections: Section[],
    onProgress: ((progress: Progress) => void) | null,
    batchSize = 10
): Promise<Progress> {
    const progressive = sourceSections.map(section => ({ name: section.name, tests: [] as TestEntry[] }))
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
