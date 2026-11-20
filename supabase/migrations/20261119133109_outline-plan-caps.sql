-- Per-account document-size caps: free accounts default to 1 MiB, paid plans
-- are raised through the service-role-only `outline_plans` table, and the
-- `outlines_plan_cap` BEFORE trigger enforces the cap on every write. The
-- rejection is a check_violation (23514), the same typed `too-large` path the
-- absolute 5 MiB backstop on outlines.data uses — the client adapter already
-- maps it without retries. Mirrors supabase/schemas/outline_plans.sql.

create table "public"."outline_plans" (
  "user_id" uuid not null,
  "plan" text not null,
  "max_data_bytes" bigint not null,
  "updated_at" timestamptz not null default timezone('utc', now()),
  constraint "outline_plans_pkey" primary key ("user_id"),
  constraint "outline_plans_user_id_fkey" foreign key ("user_id") references "auth"."users"("id") on delete cascade,
  constraint "outline_plans_cap_check" check ((max_data_bytes > 0) and (max_data_bytes < 5242880))
);

alter table "public"."outline_plans" enable row level security;

drop policy if exists "Users can read their own plan" on "public"."outline_plans";
create policy "Users can read their own plan"
  on "public"."outline_plans"
  for select
  using ((select auth.uid()) = user_id);

revoke insert, update, delete, truncate, trigger, references on "public"."outline_plans" from "anon", "authenticated";

create function "public"."enforce_outline_plan_cap"()
returns trigger
language plpgsql
security definer
set search_path = 'public'
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

revoke execute on function "public"."enforce_outline_plan_cap"() from "anon", "authenticated";

drop trigger if exists outlines_plan_cap on "public"."outlines";
create trigger outlines_plan_cap
  before insert or update on "public"."outlines"
  for each row execute function "public"."enforce_outline_plan_cap"();
