-- Fix RLS policy to avoid direct auth.uid() call per row.
-- Using (SELECT auth.uid()) lets PostgreSQL evaluate the expression once per
-- statement instead of once per row, removing the Supabase performance warning.
DROP POLICY IF EXISTS "Users can only access their own data" ON public.outlines;

CREATE POLICY "Users can only access their own data"
  ON public.outlines FOR ALL
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
