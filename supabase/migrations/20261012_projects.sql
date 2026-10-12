-- Projects: a project is a row of kind 'project' (never on the calendar); its steps are rows of kind 'step' whose parent
-- is the project. Steps use their own kind so the nightly clean-up of finished tasks (clear_finished_tasks, kind = 'task')
-- leaves them alone: a project keeps its finished steps, and POS takes a missed step off the calendar itself.
-- A step can wait on someone ("IT, network cable"), and remembers a day it was planned for but missed.
alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind = any (array['task','event','meeting','marker','project','step']));
alter table public.tasks add column if not exists wait text;
alter table public.tasks add column if not exists missed date;
alter table public.tasks add constraint tasks_wait_len check (wait is null or char_length(wait) <= 80);
