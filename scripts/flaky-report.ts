#!/usr/bin/env bun
// test-03: surface tests that pass only on a retry.
//
// Playwright's JSON report marks a test `flaky` when it failed and then passed
// on an attempt within the allowed retries. Locally retries are off, so this is
// a CI-only measure: it names the tests in the job summary, and `--strict`
// (used on `main`, where a green run is expected on the first attempt) turns a
// flaky test into a failure.
//
// A retry whose failure was only the engine closing the page (`Page closed`,
// `Target closed`, `browser has disconnected`, a protocol error) is reported as
// infrastructure instead: a retry is the only remedy for it, so failing `main`
// for it just forces a manual rerun. Assertion and timeout failures stay fatal —
// including a test timeout whose page was then closed by the teardown.
//
// Usage: bun scripts/flaky-report.ts [report.json] [--strict]

import { readFile, appendFile } from 'node:fs/promises';

type JsonError = { message?: string };
type JsonResult = { status?: string; errors?: JsonError[]; error?: JsonError };
type JsonTest = { projectName?: string; status?: string; results?: JsonResult[] };
type JsonSpec = { title?: string; file?: string; tests?: JsonTest[] };
type JsonSuite = { specs?: JsonSpec[]; suites?: JsonSuite[] };

export type FlakyTest = {
    file: string;
    title: string;
    project: string;
    /** The retried failure was the page/browser closing, not a test assertion. */
    infrastructure: boolean;
};

/** Engine-level failures a retry can legitimately clear; assertions cannot. */
const INFRASTRUCTURE_ERROR =
    /page closed|target page, context or browser has been closed|target closed|browser has been closed|browser has disconnected|protocol error|page crashed/i;

const collectSpecs = (suites: JsonSuite[] | undefined, out: JsonSpec[] = []): JsonSpec[] => {
    for (const suite of suites ?? []) {
        out.push(...(suite.specs ?? []));
        collectSpecs(suite.suites, out);
    }
    return out;
};

/** The messages of the attempts that did not pass. */
const failedMessages = (test: JsonTest): string[] =>
    (test.results ?? [])
        .filter(result => result.status !== 'passed' && result.status !== 'skipped')
        .flatMap(result => [...(result.errors ?? []), ...(result.error ? [result.error] : [])])
        .map(error => String(error.message ?? ''));

/** Every test the report marks as having passed only on a retry. */
export const flakyTests = (report: unknown): FlakyTest[] => {
    const suites = (report as { suites?: JsonSuite[] } | null | undefined)?.suites;
    const flaky: FlakyTest[] = [];
    for (const spec of collectSpecs(suites)) {
        for (const test of spec.tests ?? []) {
            if (test.status !== 'flaky') continue;
            const messages = failedMessages(test);
            flaky.push({
                file: spec.file ?? '',
                title: spec.title ?? '',
                project: test.projectName ?? '',
                // Only a failure that is *nothing but* an engine closure is
                // infrastructure. A test timeout followed by "Page closed" is a
                // slow test (the timeout closed the page), so it stays fatal.
                infrastructure: messages.length > 0 && messages.every(message => INFRASTRUCTURE_ERROR.test(message)),
            });
        }
    }
    return flaky;
};

/** `main` fails a retry only when it was a test failure, not an engine failure. */
export const shouldFailStrict = (flaky: FlakyTest[]): boolean =>
    flaky.some(test => !test.infrastructure);

/** The Markdown block written to the job summary. */
export const renderSummary = (flaky: FlakyTest[], strict: boolean): string => {
    if (flaky.length === 0) {
        return '## Retried tests\n\nNo test needed a retry.';
    }
    const plural = flaky.length === 1 ? 'test' : 'tests';
    const fatal = shouldFailStrict(flaky);
    return [
        '## Retried tests',
        '',
        `${flaky.length} ${plural} passed only on a retry:`,
        '',
        ...flaky.map(test => `- [${test.project}] \`${test.file}\` — ${test.title}`
            + (test.infrastructure ? ' (page closed: infrastructure, not fatal)' : '')),
        '',
        strict
            ? fatal
                ? '`main` must pass on the first attempt, so this fails the job.'
                : '`main` does not fail for a page/browser that closed during an attempt.'
            : 'Reported, not fatal, on pull requests.',
    ].join('\n');
};

if (import.meta.main) {
    const args = process.argv.slice(2);
    const strict = args.includes('--strict');
    const reportPath = args.find(arg => !arg.startsWith('--')) ?? 'test-results/report.json';

    let flaky: FlakyTest[] = [];
    let summary: string;
    try {
        flaky = flakyTests(JSON.parse(await readFile(reportPath, 'utf8')));
        summary = renderSummary(flaky, strict);
    } catch {
        // The run died before writing a report; the test step already failed,
        // so say so without masking that failure with a second one.
        summary = `## Retried tests\n\nNo Playwright JSON report at \`${reportPath}\`; retries were not counted.`;
    }

    console.log(summary);
    const jobSummary = process.env.GITHUB_STEP_SUMMARY;
    if (jobSummary) {
        await appendFile(jobSummary, summary + '\n\n');
    }
    if (strict && shouldFailStrict(flaky)) {
        process.exit(1);
    }
}
