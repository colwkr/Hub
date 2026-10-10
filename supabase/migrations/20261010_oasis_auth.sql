-- The Oasis lights cloud key (an access key and a refresh key; never a login or password).
-- Only the lights edge function reads or writes it, with the service role.
create table if not exists public.oasis_auth (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.oasis_auth enable row level security;
revoke all on public.oasis_auth from anon, authenticated;
