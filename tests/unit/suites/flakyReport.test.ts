// test-03: the CI retry report (scripts/flaky-report.ts).
import { describe, it } from 'bun:test';
import { flakyTests, renderSummary, shouldFailStrict } from '../../../scripts/flaky-report';
import { assert, assertEqual } from '../testing';

const report = {
    suites: [
        {
            specs: [
                {
                    title: 'passes first time',
                    file: 'tests/e2e/a.spec.ts',
                    tests: [{ projectName: 'chromium', status: 'expected' }],
                },
                {
                    title: 'skipped',
                    file: 'tests/e2e/a.spec.ts',
                    tests: [{ projectName: 'chromium', status: 'skipped' }],
                },
            ],
            suites: [
                {
                    specs: [
                        {
                            title: 'passed on a retry',
                            file: 'tests/integration/b.spec.ts',
                            tests: [
                                { projectName: 'chromium', status: 'flaky' },
                                { projectName: 'firefox', status: 'expected' },
                            ],
                        },
                        {
                            title: 'failed every time',
                            file: 'tests/integration/c.spec.ts',
                            tests: [{ projectName: 'webkit', status: 'unexpected' }],
                        },
                    ],
                },
            ],
        },
    ],
};

/** A flaky test whose failed attempt carried these error messages. */
const flakyWith = (messages: string[]) => ({
    suites: [{
        specs: [{
            file: 'tests/e2e/example.spec.ts',
            title: 'does the thing',
            tests: [{
                projectName: 'webkit',
                status: 'flaky',
                results: [
                    { status: 'timedOut', errors: messages.map(message => ({ message })) },
                    { status: 'passed' },
                ],
            }],
        }],
    }],
});

describe('flaky-report', () => {
    it('collects only the tests that passed on a retry, including nested suites', () => {
        assertEqual(flakyTests(report).length, 1);
        assertEqual(flakyTests(report)[0].file, 'tests/integration/b.spec.ts');
        assertEqual(flakyTests(report)[0].title, 'passed on a retry');
        assertEqual(flakyTests(report)[0].project, 'chromium');
    });

    it('treats a report without suites as clean', () => {
        assertEqual(flakyTests({}).length, 0);
        assertEqual(flakyTests(null).length, 0);
    });

    it('says so when nothing needed a retry', () => {
        const summary = renderSummary([], true);
        assert(summary.includes('No test needed a retry'), summary);
    });

    it('lists each retried test and marks the main-branch rule', () => {
        const flaky = flakyTests(report);
        const strict = renderSummary(flaky, true);
        assert(strict.includes('`tests/integration/b.spec.ts`'), strict);
        assert(strict.includes('[chromium]'), strict);
        assert(strict.includes('fails the job'), strict);

        const lenient = renderSummary(flaky, false);
        assert(lenient.includes('not fatal'), lenient);
        assert(!lenient.includes('fails the job'), lenient);
    });

    it('treats a page closure as infrastructure, not a test failure', () => {
        const flaky = flakyTests(flakyWith(['Error: keyboard.press: Protocol error: Page closed']))
        assertEqual(flaky[0].infrastructure, true, 'page closed is infrastructure')
        assertEqual(shouldFailStrict(flaky), false, 'main must not fail for a page that closed')
    });

    it('recognises the browser-disconnected family', () => {
        for (const message of [
            'Target page, context or browser has been closed',
            'browser has disconnected',
            'Target closed',
        ]) {
            const flaky = flakyTests(flakyWith([message]))
            assertEqual(flaky[0].infrastructure, true, `${message} is infrastructure`)
        }
    });

    it('treats a WebKit target crash as infrastructure, not a test failure', () => {
        const flaky = flakyTests(flakyWith([
            'Error: locator.count: Target crashed \n\nCall Log:\n- Timeout 40000ms exceeded while waiting on the predicate',
        ]))
        assertEqual(flaky[0].infrastructure, true, 'a crashed browser target is infrastructure')
        assertEqual(shouldFailStrict(flaky), false, 'main must not fail for a renderer crash')

        const summary = renderSummary(flaky, true)
        assert(summary.includes('browser infrastructure, not fatal'), summary)
        assert(!summary.includes('page closed:'), summary)
    });

    it('keeps a test timeout fatal even when the timeout closed the page', () => {
        // This is the WebKit tasks.spec shape: the 60 s budget ran out and the
        // teardown closed the page, so the "Page closed" is a consequence, not a
        // cause. Treating it as infrastructure would excuse a slow test.
        const flaky = flakyTests(flakyWith([
            'Test timeout of 60000ms exceeded.',
            'Error: keyboard.press: Protocol error (Input.dispatchKeyEvent): Page closed',
        ]))
        assertEqual(flaky[0].infrastructure, false, 'a slow test is not infrastructure')
        assertEqual(shouldFailStrict(flaky), true, 'the timeout stays fatal')
    });

    it('still fails when one retried test was a real failure', () => {
        const mixed = [
            ...flakyTests(flakyWith(['Page closed'])),
            ...flakyTests(flakyWith(['Error: expected 1 to be 2'])),
        ]
        assertEqual(shouldFailStrict(mixed), true, 'one assertion retry is enough to fail main')
    });

    it('says in the summary which retries were infrastructure', () => {
        const summary = renderSummary(flakyTests(flakyWith(['Page closed'])), true)
        assert(summary.includes('infrastructure, not fatal'), summary)
        assert(summary.includes('does not fail'), summary)
    });
});
