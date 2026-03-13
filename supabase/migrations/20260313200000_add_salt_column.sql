
-- Add encryption salt column so the salt can be restored on another device.
ALTER TABLE "public"."outlines"
  ADD COLUMN IF NOT EXISTS "salt" text;
