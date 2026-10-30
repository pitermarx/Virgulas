// Shared assertion helpers for the bun:test unit suites.
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
