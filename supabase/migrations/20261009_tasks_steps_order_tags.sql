-- Subtasks: a task can sit under another as a later step (done in order). When the parent goes, its steps stay.
-- pos: the order you dragged things into. tag: personal or work (or neither).
alter table public.tasks add column if not exists parent_id uuid references public.tasks(id) on delete set null;
alter table public.tasks add column if not exists pos double precision;
alter table public.tasks add column if not exists tag text check (tag in ('personal', 'work'));
create index if not exists tasks_parent_idx on public.tasks(parent_id);
