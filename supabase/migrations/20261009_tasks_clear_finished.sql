-- Tasks only live for their day. Anything scheduled before today is removed, done or not,
-- and a finished task is removed once its day is over. Events, meetings and markers are untouched.
-- Runs every 10 minutes; the app also hides them the moment the day turns over.
create extension if not exists pg_cron;

create or replace function public.clear_finished_tasks() returns void
language sql security definer set search_path = public as $$
  delete from public.tasks
  where kind = 'task'
    and (day < (now() at time zone 'America/New_York')::date
         or (done and done_at < (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')));
$$;
revoke all on function public.clear_finished_tasks() from public, anon, authenticated;

select cron.schedule('clear-finished-tasks', '*/10 * * * *', 'select public.clear_finished_tasks()');
