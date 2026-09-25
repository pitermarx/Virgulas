import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, createAsyncSectionHarness } from '../testing.js'

// Guards the Supabase schema against drift for account deletion (AGENTS Rule 4).
// The browser cannot remove the `auth.users` record, so self-service erasure
// depends on a scoped DELETE policy on `public.outlines` plus the client path
// that calls it (`remoteSync.deleteOutline`).

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const readSchema = () => readFileSync(path.join(ROOT, 'supabase/schemas/outlines.sql'), 'utf8')
const readSync = () => readFileSync(path.join(ROOT, 'source/js/sync.ts'), 'utf8')

section('Account deletion wiring')

await test('the schema defines a scoped DELETE policy for outlines', () => {
    const sql = readSchema()
    assert(
        /create policy "Users can delete their own outline"/.test(sql),
        'a DELETE policy must exist for self-service erasure'
    )
    assert(/for delete/i.test(sql), 'the policy must target the delete action')
    assert(
        /using \(\(select auth\.uid\(\)\) = user_id\)/i.test(sql),
        'the DELETE policy must be scoped to the owning user'
    )
})

await test('the DELETE policy stays scoped to the owning user', () => {
    const sql = readSchema()
    const deletePolicy = sql.slice(sql.indexOf('Users can delete their own outline'))
    // A `using (true)` or missing scope would let any signed-in user erase others.
    assert(!/using\s*\(\s*true\s*\)/i.test(deletePolicy), 'no unconditional delete policy')
})

await test('the client exposes a server-delete path', () => {
    const src = readSync()
    assert(/deleteOutline/.test(src), 'remoteSync.deleteOutline must exist')
    assert(/\.delete\(\)\.eq\('user_id'/.test(src), 'delete must be scoped by user_id')
})

section('Email-confirmation sign-up')

const readPersistence = () => readFileSync(path.join(ROOT, 'source/js/persistence.ts'), 'utf8')
const readApp = () => readFileSync(path.join(ROOT, 'source/js/app.ts'), 'utf8')

await test('sign-up records the confirmation-required state', () => {
    const src = readPersistence()
    assert(/pendingEmailConfirmation\s*=\s*!!res\?\.user && !res\?\.session/.test(src), 'signUp must detect a null session')
    assert(/needsEmailConfirmation/.test(src), 'the state must be readable by the UI')
    assert(/clearEmailConfirmation/.test(src), 'the state must be clearable after sign-in')
})

await test('the lock screen surfaces a confirmation message instead of a generic failure', () => {
    const src = readApp()
    assert(/remote-email-unconfirmed/.test(src), 'a dedicated scenario must exist')
    assert(/confirm your email address/i.test(src), 'the message must tell the user to confirm')
})

section('Options footer and account controls')


await test('the source repository is a link in the version footer, not a button', () => {
    const src = readApp()
    assert(
        !/Source repository/.test(src),
        'the standalone Source repository button must be removed'
    )
    assert(
        /class="options-footer-link"[^>]*href=\$\{REPO_URL\}/.test(src),
        'the footer must link to the repository'
    )
    assert(
        /options-footer-version"[^>]*>\$\{appVersion\.value\}/.test(src),
        'the version must render as its own element'
    )
    assert(/See on GitHub/.test(src), 'the link must be labelled')
})

await test('the delete account action is offered only in Remote mode', () => {
    const src = readApp()
    assert(/handleDeleteAccount/.test(src), 'the handler must exist')
    assert(
        /\$\{isRemote && html`[\s\S]*?Delete account[\s\S]*?`\}/.test(src),
        'the Delete account button must be gated on Remote mode'
    )
})

export default { sections }
