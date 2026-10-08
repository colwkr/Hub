-- one table holds everything with a day and time: tasks (to-dos), events (just on the calendar), meetings (with talking points and notes)
alter table public.tasks
  add column if not exists kind text not null default 'task',
  add column if not exists notes text,
  add column if not exists agenda jsonb not null default '[]'::jsonb;
alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in ('task', 'event', 'meeting'));
alter table public.tasks drop constraint if exists tasks_agenda_is_array;
alter table public.tasks add constraint tasks_agenda_is_array check (jsonb_typeof(agenda) = 'array');
alter table public.tasks drop constraint if exists tasks_notes_len;
alter table public.tasks add constraint tasks_notes_len check (notes is null or length(notes) <= 100000);
