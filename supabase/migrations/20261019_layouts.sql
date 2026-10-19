-- Layouts: per screen and per device, which widgets show, in what order, how big and with what filters (read by layout.js).
-- device is 'phone', 'tablet', 'desktop', '*' (any), or a device's own name (set with ?device=name). No row = the built-in layout.
-- widgets is an ordered list of {id, size: s|m|l|full, hidden, filter}; apps (Home only) is the icon order, [{id, hidden}].
create table if not exists public.layouts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  screen text not null check (screen ~ '^[a-z][a-z0-9_-]{0,39}$'),
  device text not null check (device = '*' or device ~ '^[a-z][a-z0-9_-]{0,39}$'),
  widgets jsonb not null default '[]'::jsonb check (jsonb_typeof(widgets) = 'array' and pg_column_size(widgets) < 20000),
  apps jsonb check (apps is null or (jsonb_typeof(apps) = 'array' and pg_column_size(apps) < 4000)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, screen, device)
);
alter table public.layouts enable row level security;
create policy "own layouts: read" on public.layouts for select using (user_id = (select auth.uid()));
create policy "own layouts: add" on public.layouts for insert with check (user_id = (select auth.uid()));
create policy "own layouts: change" on public.layouts for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own layouts: remove" on public.layouts for delete using (user_id = (select auth.uid()));
create trigger layouts_touch before update on public.layouts for each row execute function touch_updated_at();
alter publication supabase_realtime add table public.layouts;
