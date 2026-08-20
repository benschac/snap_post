create schema if not exists extensions;
create extension if not exists vector with schema extensions;

revoke all on schema snap_to_post from public, anon, authenticated;
grant usage on schema snap_to_post to service_role;

revoke all on all tables in schema snap_to_post from anon, authenticated;
grant select, insert, update, delete on all tables in schema snap_to_post to service_role;

alter default privileges for role postgres in schema snap_to_post
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema snap_to_post
  grant select, insert, update, delete on tables to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'snap-to-post-evidence',
  'snap-to-post-evidence',
  false,
  15728640,
  array['image/jpeg', 'image/heic', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
