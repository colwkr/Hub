-- Paychecks (income) and each month's saved figures (months) live in fin_docs too.
alter table public.fin_docs drop constraint fin_docs_kind_check;
alter table public.fin_docs add constraint fin_docs_kind_check check (kind = any (array['accounts','buckets','txns','bills','loans','income','months']));
