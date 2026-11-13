// test-03: the CI retry report (scripts/flaky-report.ts).
import { describe, it } from 'bun:test';
import { flakyTests, renderSummary } from '../../../scripts/flaky-report';
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
});
