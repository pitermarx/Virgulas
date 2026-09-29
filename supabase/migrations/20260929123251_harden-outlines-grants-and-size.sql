revoke references on table "public"."outlines" from "anon";

revoke trigger on table "public"."outlines" from "anon";

revoke truncate on table "public"."outlines" from "anon";

revoke references on table "public"."outlines" from "authenticated";

revoke trigger on table "public"."outlines" from "authenticated";

revoke truncate on table "public"."outlines" from "authenticated";

alter table "public"."outlines" add constraint "outlines_data_size_check" CHECK ((octet_length(data) < 16777216)) not valid;

alter table "public"."outlines" validate constraint "outlines_data_size_check";

alter table "public"."outlines" add constraint "outlines_salt_size_check" CHECK ((octet_length(salt) < 1024)) not valid;

alter table "public"."outlines" validate constraint "outlines_salt_size_check";


