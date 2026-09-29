create table if not exists public.outlines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null,
  data text not null,
  updated_at timestamptz not null default timezone('utc', now()),
  -- Bound the row so a buggy or hostile client cannot bloat storage. The document is
  -- a base64 envelope; 16 MiB is far above any realistic outline, salt is ~24 bytes.
  constraint outlines_salt_size_check check (octet_length(salt) < 1024),
  constraint outlines_data_size_check check (octet_length(data) < 16777216)
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
