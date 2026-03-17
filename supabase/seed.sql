-- Seed a deterministic local test account for auth/sync E2E flows.
-- Email: test@virgulas.com
-- Password: testpassword
-- Passphrase: correct horse battery staple

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  is_super_admin,
  is_sso_user,
  is_anonymous
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated',
  'authenticated',
  'test@virgulas.com',
  '$2a$06$7hbxoIVyAYCjdD319eM9P.4CoZ0o2kANGgZLvhkdhO8/Y8QsCyCky',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now(),
  false,
  false,
  false
)
on conflict (id) do update set
  email = excluded.email,
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = excluded.email_confirmed_at,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = now();

insert into auth.identities (
  id,
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"test@virgulas.com"}'::jsonb,
  'email',
  now(),
  now(),
  now()
)
on conflict (id) do update set
  identity_data = excluded.identity_data,
  last_sign_in_at = now(),
  updated_at = now();

insert into public.outlines (user_id, salt, data, updated_at)
values (
  '11111111-1111-1111-1111-111111111111',
  'dTUxDxBe3fkMcR8OYoA9/Q==',
  '1I40Yv5okDqdbkOUhBiETXOR/L0nh+rmuSN9ybyACZDuFzozrJfN68TlBAvynHxPeSfmymoieu/phhu4b6o597MsxHsAUMfvzR1fchHf2ZD+FEkK0XXDb4oRqi/l336RE8AnDYAHxnWYSvY+Lmriu5H0cHCpzWYztf1p2tB26ZHJGyADSLXinhaXEi006rnM',
  now()
)
on conflict (user_id) do update set
  salt = excluded.salt,
  data = excluded.data,
  updated_at = excluded.updated_at;
