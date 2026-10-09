-- Bank alert emails (Regions) handed to POS by a small Google script in the owner's account.
-- Every email is kept as it arrived so the reader can be improved and re-run; readable only by its owner.
create table if not exists public.bank_mail (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 120),
  received_at timestamptz not null,
  sender text,
  subject text,
  body text check (char_length(body) <= 12000),
  parsed jsonb,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.bank_mail enable row level security;
create policy "bank_mail: owner reads" on public.bank_mail for select using (auth.uid() = user_id);

-- The script proves who it's sending for with a key; only the key's SHA-256 is stored here.
create table if not exists public.bank_mail_keys (
  key_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.bank_mail_keys enable row level security;
-- no policies: only the server (service role) reads this table
alter publication supabase_realtime add table public.bank_mail;
