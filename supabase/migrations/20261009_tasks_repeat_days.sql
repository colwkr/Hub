-- A repeat can cover a set of weekdays: {"freq":"days","days":[1,2,3,4]} is every Monday to Thursday (0 is Sunday).
alter table public.tasks drop constraint tasks_repeat_shape;
alter table public.tasks add constraint tasks_repeat_shape check (
  repeat is null or (jsonb_typeof(repeat) = 'object' and (
    repeat->>'freq' = any (array['daily','weekdays','weekly','monthly','yearly'])
    or (repeat->>'freq' = 'days' and jsonb_typeof(repeat->'days') = 'array' and jsonb_array_length(repeat->'days') between 1 and 7)
  ))
);
