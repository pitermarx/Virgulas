create table if not exists public.outlines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null,
  data text not null,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.outlines enable row level security;

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
