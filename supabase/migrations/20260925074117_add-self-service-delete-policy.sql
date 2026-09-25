-- Self-service erasure: allow a signed-in user to delete only their own
-- encrypted outline row. This is the server-data half of account deletion.
--
-- The `outlines.user_id` foreign key already cascades from `auth.users`, so
-- deleting the auth user also removes this row; the browser client cannot do
-- that (it needs the service role), but it can delete the row directly.
drop policy if exists "Users can delete their own outline" on "public"."outlines";

create policy "Users can delete their own outline"
  on "public"."outlines"
  for delete
  to public
  using ((select auth.uid()) = user_id);
