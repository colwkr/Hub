-- markers: a named moment on the calendar (like waking up) that takes no time
alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in ('task', 'event', 'meeting', 'marker'));
