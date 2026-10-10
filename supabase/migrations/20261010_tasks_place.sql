-- Where a task or event happens, and the drive to it from home: { q, name, addr, lat, lon, mi, drive, from }.
alter table public.tasks add column if not exists place jsonb;
