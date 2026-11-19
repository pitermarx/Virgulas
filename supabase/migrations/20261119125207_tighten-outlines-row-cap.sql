-- Tighten the outlines row cap from 16 MiB to 5 MiB: the server-side half of
-- the document-size quota. 5 MiB sits above any document a browser can even
-- hold — the localStorage quota tops out around 5 M ASCII chars (~4.8 MB) of
-- `salt|envelope` — so no legitimate client reaches the cap; it bounds
-- abusive or buggy writers. The client-side half (a proactive warning as the
-- slot grows) lives in source/js/quota.ts.

alter table "public"."outlines" drop constraint "outlines_data_size_check";

alter table "public"."outlines" add constraint "outlines_data_size_check" CHECK ((octet_length(data) < 5242880)) not valid;

alter table "public"."outlines" validate constraint "outlines_data_size_check";
