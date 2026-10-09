-- General records for the sections that are not tasks or money: the car first (vehicle, services, mileage readings, notes).
-- Same shape as fin_docs: one row per thing, owner-only, the app keeps the fields in data.
create table if not exists public.records (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  kind text not null check (kind ~ '^[a-z][a-z0-9_-]{0,39}$'),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists records_user_kind_idx on public.records (user_id, kind);
alter table public.records enable row level security;
create policy "own records: read" on public.records for select using (user_id = (select auth.uid()));
create policy "own records: add" on public.records for insert with check (user_id = (select auth.uid()));
create policy "own records: change" on public.records for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own records: remove" on public.records for delete using (user_id = (select auth.uid()));
create trigger records_touch before update on public.records for each row execute function touch_updated_at();
alter publication supabase_realtime add table public.records;
