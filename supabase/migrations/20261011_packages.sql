-- Packages: the tracking service key, the last raw answer (for fixing how it's read), and places already looked up.
-- Only the packages edge function (service role) touches these; packages themselves are records (kind 'package').
create table if not exists public.pos_secrets (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.package_raw (id text primary key, raw jsonb, at timestamptz not null default now());
create table if not exists public.geo_cache (q text primary key, lat double precision, lon double precision, at timestamptz not null default now());
alter table public.pos_secrets enable row level security;
alter table public.package_raw enable row level security;
alter table public.geo_cache enable row level security;
revoke all on public.pos_secrets, public.package_raw, public.geo_cache from anon, authenticated;
create extension if not exists pg_net;
-- every 30 minutes the packages function refreshes everything on its way (the secret's SHA-256 is in the function)
-- select cron.schedule('refresh-packages', '7,37 * * * *', $$select net.http_post(url := '.../functions/v1/packages', headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<secret>'), body := '{"action":"refresh"}'::jsonb, timeout_milliseconds := 60000)$$);
