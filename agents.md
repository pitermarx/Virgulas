# Agents Guidance

This document defines the rules every agent or contributor **must** follow when making changes to this repository.

---

## Rule 1 — Respect SPEC.vmd

**`SPEC.vmd` is the source of truth. You must not change it unless specifically instructed to do so**

Features that do not exist in `SPEC.vmd` are to be removed. Features that exist in `SPEC.vmd` must exist

## Rule 2 — Keep README.md in sync

`README.md` is the authoritative description of everything the app does.

**Whenever you add, remove, or change a feature you must update `README.md` in the same commit/PR.**

---

## Rule 3 — Every feature must have a Playwright test

**Whenever you add or change feature or behaviour you must add or update the corresponding test(s).**

---

## Rule 4 — Update schema files for any database schema change

**Whenever you add, modify, or remove a database table, column, index, policy, or function you must update the corresponding schema file in `supabase/schemas/` in the same commit/PR.**

Schema files live in `supabase/schemas/` (e.g. `oulines.sql`). Migrations are **auto-generated** by Supabase from the schema diff — you do not write or edit migration files manually.

To apply and generate the migration after editing a schema file:

```bash
npm run db:migrate -- <migration-name>
```

Checklist for schema changes:

- [ ] The relevant `supabase/schemas/*.sql` file is updated.
- [ ] `supabase/seed.sql` is updated if the schema change affects seed data.

---
