
  create table "public"."outlines" (
    "user_id" uuid not null,
    "salt" text not null,
    "data" text not null,
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now())
      );


alter table "public"."outlines" enable row level security;

CREATE UNIQUE INDEX outlines_pkey ON public.outlines USING btree (user_id);

alter table "public"."outlines" add constraint "outlines_pkey" PRIMARY KEY using index "outlines_pkey";

alter table "public"."outlines" add constraint "outlines_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."outlines" validate constraint "outlines_user_id_fkey";

grant delete on table "public"."outlines" to "anon";

grant insert on table "public"."outlines" to "anon";

grant references on table "public"."outlines" to "anon";

grant select on table "public"."outlines" to "anon";

grant trigger on table "public"."outlines" to "anon";

grant truncate on table "public"."outlines" to "anon";

grant update on table "public"."outlines" to "anon";

grant delete on table "public"."outlines" to "authenticated";

grant insert on table "public"."outlines" to "authenticated";

grant references on table "public"."outlines" to "authenticated";

grant select on table "public"."outlines" to "authenticated";

grant trigger on table "public"."outlines" to "authenticated";

grant truncate on table "public"."outlines" to "authenticated";

grant update on table "public"."outlines" to "authenticated";

grant delete on table "public"."outlines" to "service_role";

grant insert on table "public"."outlines" to "service_role";

grant references on table "public"."outlines" to "service_role";

grant select on table "public"."outlines" to "service_role";

grant trigger on table "public"."outlines" to "service_role";

grant truncate on table "public"."outlines" to "service_role";

grant update on table "public"."outlines" to "service_role";


  create policy "Users can insert their own outline"
  on "public"."outlines"
  as permissive
  for insert
  to public
with check (((select auth.uid()) = user_id));



  create policy "Users can read their own outline"
  on "public"."outlines"
  as permissive
  for select
  to public
using (((select auth.uid()) = user_id));



  create policy "Users can update their own outline"
  on "public"."outlines"
  as permissive
  for update
  to public
using (((select auth.uid()) = user_id))
with check (((select auth.uid()) = user_id));



