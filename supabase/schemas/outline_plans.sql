-- Per-account document-size plans (the paid-tier half of the quota).
--
-- A plan row is service-owned by design: grants and RLS allow a user to read
-- their own row (so the app can show the cap later), but no client role may
-- insert, update or delete one — only the service role (a checkout webhook
-- or the back office) writes here. A column on `outlines` could never do
-- this job: the client owns every byte of its own row, so a self-service
-- cap is not a cap. The `outlines_plan_cap` BEFORE trigger reads the cap
-- with SECURITY DEFINER, so enforcement cannot be bypassed by the very
-- session that writes the row it is being checked against.

create table if not exists public.outline_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Informational label ('pro', 'team', …); enforcement reads max_data_bytes only.
  plan text not null,
  max_data_bytes bigint not null,
  updated_at timestamptz not null default timezone('utc', now()),
  -- A plan cap is always positive and always below the absolute backstop on
  -- outlines.data (5 MiB), so no plan can out-loosen the hostile-writer bound.
  constraint outline_plans_cap_check check (max_data_bytes > 0 and max_data_bytes < 5242880)
);

alter table public.outline_plans enable row level security;

-- Clients may read their own plan; no write policy exists, so RLS alone
-- already blocks every client write.
drop policy if exists "Users can read their own plan" on public.outline_plans;
create policy "Users can read their own plan"
  on public.outline_plans
  for select
  using ((select auth.uid()) = user_id);

-- Belt and braces on top of RLS: revoke the write grants Supabase's default
-- privileges hand to the client roles outright.
revoke insert, update, delete, truncate, trigger, references on public.outline_plans from anon, authenticated;

-- Raising a plan is data, not a deploy:
--   insert into public.outline_plans (user_id, plan, max_data_bytes)
--   values ('<uid>', 'pro', 5242880 - 1)
--   on conflict (user_id) do update set plan = excluded.plan, max_data_bytes = excluded.max_data_bytes;

-- ── Enforcement: the BEFORE trigger on outlines ──────────────────────────────
--
-- Free is the default: an account with no plan row is capped at 1 MiB. The
-- rejection raises with errcode 'check_violation' (23514), so PostgREST and
-- the client adapter surface it through the same `too-large` path as the
-- absolute backstop constraint — one typed error, no retries.

create or replace function public.enforce_outline_plan_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap bigint;
begin
  select coalesce(max(p.max_data_bytes), 1048576) into cap
    from public.outline_plans p
   where p.user_id = new.user_id;
  if octet_length(new.data) >= cap then
    raise exception 'Document exceeds the account plan cap of % bytes.', cap
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Only the trigger fires it; no client may call it directly.
revoke execute on function public.enforce_outline_plan_cap() from anon, authenticated;

drop trigger if exists outlines_plan_cap on public.outlines;
create trigger outlines_plan_cap
  before insert or update on public.outlines
  for each row execute function public.enforce_outline_plan_cap();
