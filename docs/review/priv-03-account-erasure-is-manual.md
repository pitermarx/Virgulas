# Account erasure needs a manual step

- **Severity:** Medium
- **Confidence:** code-read (stated on the privacy page and in the `deleteOutline` comment in `sync.ts`)
- **Spec impact:** schema change (Rule 4)

## Description

"Delete account" removes the encrypted `outlines` row and signs out. The `auth.users` record (email, password hash, sign-in metadata) remains because the browser client cannot delete it. The privacy page asks users to contact the maintainer. Where GDPR applies, erasure on request has to be done without undue delay, so this depends on someone reading an email.

## Evidence

- [source/js/sync.ts](../../source/js/sync.ts) (`deleteOutline`)
- [source/js/persistence.ts](../../source/js/persistence.ts#L1000) (`deleteAccount`)
- [source/privacy.html](../../source/privacy.html)

## Suggested fix

Add a `security definer` function that deletes the caller's own auth record, for example:

```sql
create function public.delete_own_account() returns void
language sql security definer set search_path = '' as $$
  delete from auth.users where id = (select auth.uid());
$$;
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
```

`outlines` rows are removed by the existing `on delete cascade`. Call it through `sync.ts`, then sign out and wipe the device with the existing `wipeDeviceData()`. Update the schema file (Rule 4) and the privacy page. Alternatively use an Edge Function with the service role.

## Tests

Playwright against local Supabase: sign up, delete, then sign-in fails and the row is gone. This also needs the real-backend test layer from test-01.

<!-- roadmap -->
## Roadmap position

- **Phase:** [6 — Security, privacy and compliance hardening](README.md#phase-6)
- **Size:** M
- **Do these first:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md), [test-01](test-01-no-real-backend-e2e.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md)
- **Related:** [scale-01](scale-01-open-signup-storage-abuse.md)
