-- Seed the tester@virgulas.com test account so it can be used in automated tests.
-- The user is created in auth.users (password: virgulas) and their outline data is
-- pre-populated in public.outlines.

-- Create the test user in auth if it does not already exist.
INSERT INTO auth.users (
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
    updated_at
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    '6d7b1ecc-2af7-4063-a7d0-04b1ba8b1ce7',
    'authenticated',
    'authenticated',
    'tester@virgulas.com',
    crypt('virgulas', gen_salt('bf')),
    NOW(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    NOW(),
    NOW()
) ON CONFLICT (id) DO NOTHING;

-- Seed the outline data for the test user.
INSERT INTO public.outlines (user_id, data, version, updated_at)
VALUES (
    '6d7b1ecc-2af7-4063-a7d0-04b1ba8b1ce7',
    'H4sIAAAAAAAACiWMSw7CMAxE7zLrrIrY9CqIRZW4xJJTh9h8pKp3x8Bq9Oa3o2jGvGOo+le5YMadxNZHb22z82s6IcHpHfG/lVDI8uDurFuYYeTKUgYFXa5BKrJ0o7haFzE6Ep407NeeArxSoxgK36rj+ABjk56lhAAAAA==',
    2,
    '2026-03-12 18:10:18.884+00'
) ON CONFLICT (user_id) DO UPDATE
    SET data       = EXCLUDED.data,
        version    = EXCLUDED.version,
        updated_at = EXCLUDED.updated_at;
