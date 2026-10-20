-- Virgulas: one encrypted document row per user (docs/storage-interface.md §4.2).
-- `user` is the owning account's UUID (the JWT `sub`, url-safe base64 in JSON);
-- the record API's ACL rules compare it against `_USER_.id`.
CREATE TABLE IF NOT EXISTS outlines (
  id BLOB PRIMARY KEY NOT NULL CHECK(is_uuid_v7(id)) DEFAULT (uuid_v7()),
  "user" BLOB NOT NULL REFERENCES _user(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  salt TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
