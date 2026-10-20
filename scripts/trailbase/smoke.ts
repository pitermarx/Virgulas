// Smoke test against a local TrailBase (scripts/trailbase/compose.yml).
// Exercises the exact request shapes `source/js/trailbaseBackend.ts` uses:
// register → (email verification via Mailpit) → login → record
// create/list/patch/clear, including the ACL owner check.
//
// Usage: bun scripts/trailbase/smoke.ts [base-url] [email]
import { $ } from 'bun'

const base = process.argv[2] ?? 'http://127.0.0.1:8099'
const mailpit = 'http://127.0.0.1:8025'
const email = process.argv[3] ?? `smoke-${Date.now()}@virgulas.com`
const password = 'pw-123456'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const json = async (res: Response): Promise<any> => {
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

// 1. Register (anti-enumeration: 200 even for duplicates, no session).
{
  const res = await fetch(`${base}/api/auth/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, password_repeat: password })
  })
  check('register', res.ok, `status ${res.status}`)
}

// 2. Verify the email through the link Mailpit captured.
{
  await new Promise((r) => setTimeout(r, 1500))
  const messages = await (await fetch(`${mailpit}/api/v1/messages`)).json()
  const message = (messages.messages ?? []).find((m: any) => m.To?.some((t: any) => t.Address === email))
  check('verification email captured', !!message)
  if (message) {
    const full = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json()
    const url = (full.Text as string).match(/https?:\/\/\S*verify_email\/confirm\/\S+/)?.[0]
    check('verification link found', !!url)
    if (url) {
      const res = await fetch(url, { redirect: 'follow' })
      check('email verified', res.ok, `status ${res.status}`)
    }
  }
}

// 3. Login → tokens + JWT sub.
let token = ''
let sub = ''
{
  const res = await fetch(`${base}/api/auth/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_or_username: email, password })
  })
  const body = await json(res)
  token = body.auth_token ?? ''
  sub = token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub : ''
  check('login', res.ok && !!token, `status ${res.status}`)
  check('jwt sub present', !!sub, sub)
}

const auth = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
const row = { user: sub, data: 'v2:600000:ciphertext-1', salt: 'c2FsdA==', updated_at: Date.now() }

// 4. Create the row (the salt's first upload).
let id = ''
{
  const res = await fetch(`${base}/api/records/v1/outlines`, { method: 'POST', headers: auth, body: JSON.stringify(row) })
  const body = await json(res)
  id = body.ids?.[0] ?? ''
  check('record create', res.ok && !!id, `status ${res.status}`)
}

// 5. List (?_limit=1) — returns the owner's row.
{
  const res = await fetch(`${base}/api/records/v1/outlines?_limit=1`, { headers: auth })
  const body = await json(res)
  check('record list', res.ok && body.records?.length === 1, `status ${res.status}, ${body.records?.length ?? 0} row(s)`)
}

// 6. Patch the same row (subsequent saves).
{
  const res = await fetch(`${base}/api/records/v1/outlines/${id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ data: 'v2:600000:ciphertext-2', updated_at: Date.now() })
  })
  check('record patch', res.ok, `status ${res.status}`)
}

// 7. The owner field is ACL-verified: a foreign user must not be accepted.
{
  const forged = await fetch(`${base}/api/auth/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `attacker-${Date.now()}@virgulas.com`, password, password_repeat: password })
  })
  void forged
  await new Promise((r) => setTimeout(r, 1200))
  const messages = await (await fetch(`${mailpit}/api/v1/messages`)).json()
  const message = [...(messages.messages ?? [])].reverse().find((m: any) => (m.To ?? []).some((t: any) => t.Address.startsWith('attacker-')))
  if (message) {
    const full = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json()
    const url = (full.Text as string).match(/https?:\/\/\S*verify_email\/confirm\/\S+/)?.[0]
    if (url) await fetch(url)
    const res = await fetch(`${base}/api/auth/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_or_username: message.To[0].Address, password })
    })
    const attacker = await json(res)
    const create = await fetch(`${base}/api/records/v1/outlines`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${attacker.auth_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...row, user: sub })
    })
    check('ACL rejects foreign owner claim', create.status === 403, `status ${create.status}`)
  } else {
    check('ACL rejects foreign owner claim', false, 'attacker verification email not found')
  }
}

// 8. Clear (sign-out wipe): delete the row.
{
  const res = await fetch(`${base}/api/records/v1/outlines/${id}`, { method: 'DELETE', headers: auth })
  check('record delete', res.ok, `status ${res.status}`)
}

process.exit(failures ? 1 : 0)
