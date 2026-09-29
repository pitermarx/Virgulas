import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, assertEqual, createAsyncSectionHarness } from '../testing.js'

// Guards the supply-chain and schema hardening tracked in docs/SECURITY.md:
// every workflow action pinned to a commit SHA, and the outlines table bounded.

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

section('Workflow action pinning')

const workflowDir = path.join(ROOT, '.github/workflows')
const workflowFiles = readdirSync(workflowDir).filter((f) => f.endsWith('.yml'))

await test('every workflow action is pinned to a commit SHA with a version comment', () => {
    for (const file of workflowFiles) {
        const lines = read(path.join('.github/workflows', file)).split('\n')
        for (const line of lines) {
            const match = line.match(/uses:\s*(\S+)/)
            if (!match) continue
            const ref = match[1]
            // Local composite actions (`./...`) and docker refs are out of scope.
            if (ref.startsWith('./') || ref.startsWith('docker://')) continue
            assert(
                /@[0-9a-f]{40}$/.test(ref),
                `${file}: "${ref}" must be pinned to a 40-character commit SHA`
            )
            assert(
                /#\s*v\d/.test(line),
                `${file}: "${ref}" must keep a "# vN" comment so Dependabot can bump it`
            )
        }
    }
})

await test('the workflows are discovered (the guard is not vacuous)', () => {
    assert(workflowFiles.length >= 2, `expected ci.yml and daily.yml, found ${workflowFiles.join(', ')}`)
})

section('Outlines table hardening')

const outlinesSchema = read('supabase/schemas/outlines.sql')

await test('client roles cannot truncate, alter triggers, or add references', () => {
    assert(
        /revoke\s+truncate\s*,\s*trigger\s*,\s*references\s+on\s+public\.outlines\s+from\s+anon\s*,\s*authenticated;/i.test(
            outlinesSchema
        ),
        'anon/authenticated must not hold TRUNCATE, TRIGGER, or REFERENCES'
    )
})

await test('the row size is bounded', () => {
    assert(/outlines_data_size_check\s+check\s*\(\s*octet_length\(data\)\s*</i.test(outlinesSchema), 'data needs a size cap')
    assert(/outlines_salt_size_check\s+check\s*\(\s*octet_length\(salt\)\s*</i.test(outlinesSchema), 'salt needs a size cap')
})

await test('the generated migration exists for the schema change', () => {
    const migrations = readdirSync(path.join(ROOT, 'supabase/migrations'))
    assertEqual(
        migrations.filter((f) => f.includes('harden-outlines-grants-and-size')).length,
        1,
        'exactly one generated migration should carry the hardening'
    )
})
