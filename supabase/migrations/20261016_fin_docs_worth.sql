-- Net worth history: one doc per month (id worth-YYYY-MM) holding each day's totals of what you own and what you owe.
alter table public.fin_docs drop constraint fin_docs_kind_check;
alter table public.fin_docs add constraint fin_docs_kind_check check (kind = any (array['accounts','buckets','txns','bills','loans','income','months','worth']));
