#!/usr/bin/env bun
// test-03: surface tests that pass only on a retry.
//
// Playwright's JSON report marks a test `flaky` when it failed and then passed
// on an attempt within the allowed retries. Locally retries are off, so this is
// a CI-only measure: it names the tests in the job summary, and `--strict`
// (used on `main`, where a green run is expected on the first attempt) turns a
// flaky test into a failure.
//
// Usage: bun scripts/flaky-report.ts [report.json] [--strict]

import { readFile, appendFile } from 'node:fs/promises';

type JsonTest = { projectName?: string; status?: string };
type JsonSpec = { title?: string; file?: string; tests?: JsonTest[] };
type JsonSuite = { specs?: JsonSpec[]; suites?: JsonSuite[] };

export type FlakyTest = { file: string; title: string; project: string };

const collectSpecs = (suites: JsonSuite[] | undefined, out: JsonSpec[] = []): JsonSpec[] => {
    for (const suite of suites ?? []) {
        out.push(...(suite.specs ?? []));
        collectSpecs(suite.suites, out);
    }
    return out;
};

/** Every test the report marks as having passed only on a retry. */
export const flakyTests = (report: unknown): FlakyTest[] => {
    const suites = (report as { suites?: JsonSuite[] } | null | undefined)?.suites;
    const flaky: FlakyTest[] = [];
    for (const spec of collectSpecs(suites)) {
        for (const test of spec.tests ?? []) {
            if (test.status !== 'flaky') continue;
            flaky.push({
                file: spec.file ?? '',
                title: spec.title ?? '',
                project: test.projectName ?? '',
            });
        }
    }
    return flaky;
};

/** The Markdown block written to the job summary. */
export const renderSummary = (flaky: FlakyTest[], strict: boolean): string => {
    if (flaky.length === 0) {
        return '## Retried tests\n\nNo test needed a retry.';
    }
    const plural = flaky.length === 1 ? 'test' : 'tests';
    return [
        '## Retried tests',
        '',
        `${flaky.length} ${plural} passed only on a retry (flaky):`,
        '',
        ...flaky.map(test => `- [${test.project}] \`${test.file}\` — ${test.title}`),
        '',
        strict
            ? '`main` must pass on the first attempt, so this fails the job.'
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
    if (strict && flaky.length > 0) {
        process.exit(1);
    }
}
