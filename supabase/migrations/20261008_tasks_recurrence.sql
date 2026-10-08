-- repeating markers, events and meetings.
-- repeat: {freq: daily|weekdays|weekly|monthly|yearly, until: 'YYYY-MM-DD'|null, skip: ['YYYY-MM-DD', ...]}; the row's day is the first one.
-- A single changed occurrence is its own row pointing back at its series (series_id) and the day it replaces (orig_day).
alter table public.tasks
  add column if not exists repeat jsonb,
  add column if not exists series_id uuid references public.tasks(id) on delete cascade,
  add column if not exists orig_day date;
create index if not exists tasks_series_id_idx on public.tasks(series_id);
alter table public.tasks drop constraint if exists tasks_repeat_shape;
alter table public.tasks add constraint tasks_repeat_shape check (
  repeat is null or (jsonb_typeof(repeat) = 'object' and repeat->>'freq' in ('daily', 'weekdays', 'weekly', 'monthly', 'yearly'))
);
