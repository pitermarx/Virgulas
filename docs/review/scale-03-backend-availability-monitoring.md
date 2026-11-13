# The backend can pause or fail without anyone noticing

- **Severity:** Medium
- **Confidence:** code-read for the missing monitoring; plan limits are from Supabase's published free-tier behaviour and should be checked against the actual plan
- **Spec impact:** none

## Description

- On a free Supabase plan, projects are paused after a period of inactivity and have no automatic backups. If the hosted project is on the free plan, Remote users get silent sync errors until someone un-pauses it, and the only copy of their ciphertext has no backup (dur-03).
- The daily production run (`daily.yml`) excludes every spec that touches Supabase, so no scheduled check calls the backend. Nothing alerts on Supabase, Cloudflare or the Umami VPS being down.
- In the app, "backend unreachable" and "browser offline" are not distinguished (err-03).
- The analytics host is a single VPS and Umami is the only third-party script, so its outage should not block the app (it is `defer`, which is good), but nothing monitors it either.

## Evidence

- [.github/workflows/daily.yml](../../.github/workflows/daily.yml)
- [source/js/sync.ts](../../source/js/sync.ts)

## Suggested fix

Add a scheduled synthetic check (a minimal request with the publishable key, for example the auth settings endpoint) that opens an issue or notifies on failure, and an uptime monitor for the site and the analytics host. Confirm the plan, backup and pause policy, and document the recovery procedure. Show "Sync server unreachable" separately from "Offline" in the app.

## Tests

The scheduled check is the test; add a unit test for the status classification.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0B — Quick wins (operations and CI)](README.md#phase-0b)
- **Size:** S
- **Do these first:** —
- **Unblocks:** [web-02](web-02-monitoring-status-page-and-csp-reporting.md)
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [err-03](err-03-sync-errors-without-detail.md)
