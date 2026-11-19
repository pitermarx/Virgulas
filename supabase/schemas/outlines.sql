create table if not exists public.outlines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null,
  data text not null,
  updated_at timestamptz not null default timezone('utc', now()),
  -- Absolute backstop above every plan cap (outline_plans.sql adds the per-account
  -- layer, 1 MiB by default). 5 MiB sits above any document a browser can even hold:
  -- the localStorage quota tops out around 5 M ASCII chars (~4.8 MB) of `salt|envelope`,
  -- so a legitimate client never reaches this cap — it bounds abusive writers whatever
  -- a plan row says. Salt is ~24 bytes.
  constraint outlines_salt_size_check check (octet_length(salt) < 1024),
  constraint outlines_data_size_check check (octet_length(data) < 5242880)
);

alter table public.outlines enable row level security;

-- Defense in depth: TRUNCATE is not subject to RLS (and is not reachable through
-- PostgREST today), and the client roles never need TRIGGER or REFERENCES. These
-- grants come from Supabase's default privileges on the public schema. service_role
-- keeps its grants for admin and back-office work.
revoke truncate, trigger, references on public.outlines from anon, authenticated;

drop policy if exists "Users can read their own outline" on public.outlines;
create policy "Users can read their own outline"
  on public.outlines
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own outline" on public.outlines;
create policy "Users can insert their own outline"
  on public.outlines
  for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own outline" on public.outlines;
create policy "Users can update their own outline"
  on public.outlines
  for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Self-service erasure: a signed-in user may delete only their own row.
-- This is the server-data half of account deletion; the browser cannot remove
-- the auth.users record itself (that requires the service role).
drop policy if exists "Users can delete their own outline" on public.outlines;
create policy "Users can delete their own outline"
  on public.outlines
  for delete
  using ((select auth.uid()) = user_id);
