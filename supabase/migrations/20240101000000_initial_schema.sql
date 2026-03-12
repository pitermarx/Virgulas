-- Create the outlines table used by the Virgulas cloud sync feature.
-- Each row stores the compressed outline document for one authenticated user.
CREATE TABLE IF NOT EXISTS public.outlines (
  user_id    UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data       TEXT        NOT NULL,
  version    BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security so users can only access their own data.
ALTER TABLE public.outlines ENABLE ROW LEVEL SECURITY;

-- Single policy covering all operations (SELECT / INSERT / UPDATE / DELETE).
CREATE POLICY "Users can only access their own data"
  ON public.outlines FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
