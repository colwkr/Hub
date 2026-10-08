-- marker types: sleep and wake markers pair up to dim the hours between them
alter table public.tasks add column if not exists subtype text;
alter table public.tasks drop constraint if exists tasks_subtype_check;
alter table public.tasks add constraint tasks_subtype_check check (subtype is null or (kind = 'marker' and subtype in ('sleep', 'wake')));
