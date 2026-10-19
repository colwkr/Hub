-- Remote control (remote.js). devices: each open copy of POS, by name ('ipad', 'phone', 'pc', or one given with
-- ?device=name): its type, the screen it's on, when it was last seen (every minute) and used, and its answer to the
-- last command it ran. commands: one row per command (open, show, view, scroll), aimed at a device name, a type, or '*';
-- copies hear them by realtime and ignore any older than 15 seconds. Rows are tiny; old ones can be cleared any time.
create table if not exists public.devices (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[a-z][a-z0-9_-]{0,39}$'),
  type text not null check (type in ('phone', 'tablet', 'desktop')),
  label text check (char_length(label) <= 40),
  screen text check (char_length(screen) <= 40),
  seen_at timestamptz not null default now(),
  active_at timestamptz,
  last_command bigint,
  last_result jsonb check (last_result is null or (jsonb_typeof(last_result) = 'object' and pg_column_size(last_result) < 2000)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.devices enable row level security;
create policy "own devices: read" on public.devices for select using (user_id = (select auth.uid()));
create policy "own devices: add" on public.devices for insert with check (user_id = (select auth.uid()));
create policy "own devices: change" on public.devices for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own devices: remove" on public.devices for delete using (user_id = (select auth.uid()));
create trigger devices_touch before update on public.devices for each row execute function touch_updated_at();

create table if not exists public.commands (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  target text not null check (target = '*' or target ~ '^[a-z][a-z0-9_-]{0,39}$'),
  action text not null check (action in ('open', 'show', 'view', 'scroll')),
  args jsonb not null default '{}'::jsonb check (jsonb_typeof(args) = 'object' and pg_column_size(args) < 2000),
  created_at timestamptz not null default now()
);
create index if not exists commands_user_created_idx on public.commands (user_id, created_at desc);
alter table public.commands enable row level security;
create policy "own commands: read" on public.commands for select using (user_id = (select auth.uid()));
create policy "own commands: add" on public.commands for insert with check (user_id = (select auth.uid()));
create policy "own commands: remove" on public.commands for delete using (user_id = (select auth.uid()));
alter publication supabase_realtime add table public.commands;
