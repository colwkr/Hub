-- Claude usage → POS. A small Chrome extension on the owner's PC reads the usage percentages Claude shows on its
-- Usage page and hands them to this function. It proves itself with a key whose SHA-256 is below (the key itself
-- only lives on the PC). It can only write the one 'claude-usage' row: percentages, reset times, and when it last
-- checked. No login, password or cookie ever comes here, and nothing here can be read back through this function.
create or replace function public.claude_usage_put(p_nonce text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  owner constant uuid := '91a0d7d5-d449-4922-a08c-3c3092c608a3';
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  patch jsonb;
begin
  if p_nonce is null or encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex')
     <> 'bf422e93db2b15681ef0191530f215e89d0fc128eacbb89994316d12f2ebb393' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 4000 then
    raise exception 'bad data' using errcode = '22023';
  end if;
  if p_data ? 'limits' and (jsonb_typeof(p_data->'limits') <> 'object'
     or (select count(*) from jsonb_object_keys(p_data->'limits')) > 10) then
    raise exception 'bad limits' using errcode = '22023';
  end if;
  -- every check marks when the PC last got through; a good read also replaces the numbers
  patch := jsonb_build_object(
    'seen', now_ms,
    'err', case when jsonb_typeof(p_data->'err') = 'string' then to_jsonb(left(p_data->>'err', 120)) else 'null'::jsonb end,
    'via', case when jsonb_typeof(p_data->'via') = 'string' then to_jsonb(left(p_data->>'via', 20)) else 'null'::jsonb end);
  if p_data ? 'limits' then
    patch := patch || jsonb_build_object('limits', p_data->'limits', 'at', now_ms);
  end if;
  insert into public.records (user_id, id, kind, data)
  values (owner, 'claude-usage', 'claude', patch)
  on conflict (user_id, id) do update set data = public.records.data || excluded.data, updated_at = now();
end
$$;

revoke all on function public.claude_usage_put(text, jsonb) from public;
grant execute on function public.claude_usage_put(text, jsonb) to anon, authenticated;
