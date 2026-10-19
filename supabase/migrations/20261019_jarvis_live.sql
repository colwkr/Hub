-- Jarvis's live state for the Jarvis widget (jarvis.js): one row per user, updated a few times a second while he
-- listens, thinks and speaks; open copies of POS hear it by realtime. alive_at is his heartbeat (every minute).
create table if not exists public.jarvis_live (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  state text not null default 'idle' check (state in ('starting', 'idle', 'listening', 'thinking', 'speaking', 'error')),
  muted boolean not null default false,
  conversation boolean not null default false,
  heard text not null default '' check (char_length(heard) <= 4000),
  heard_final boolean not null default false,
  reply text not null default '' check (char_length(reply) <= 8000),
  turn integer not null default 0,
  alive_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.jarvis_live enable row level security;
create policy "own jarvis_live: read" on public.jarvis_live for select using (user_id = (select auth.uid()));
create policy "own jarvis_live: add" on public.jarvis_live for insert with check (user_id = (select auth.uid()));
create policy "own jarvis_live: change" on public.jarvis_live for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own jarvis_live: remove" on public.jarvis_live for delete using (user_id = (select auth.uid()));
create trigger jarvis_live_touch before update on public.jarvis_live for each row execute function touch_updated_at();
alter publication supabase_realtime add table public.jarvis_live;

-- commands: 'jarvis' opens the Jarvis widget on a device (when he hears the wake word)
alter table public.commands drop constraint if exists commands_action_check;
alter table public.commands add constraint commands_action_check check (action in ('open', 'show', 'view', 'scroll', 'jarvis'));
