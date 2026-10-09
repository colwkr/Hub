-- A task can belong to a list (like "To buy" or "Sell or give away"): things to keep in mind without a day.
alter table public.tasks add column if not exists list text check (char_length(list) <= 40);
