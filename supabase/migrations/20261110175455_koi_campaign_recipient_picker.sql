create function public.koi_campaign_recipient_picker(
  p_list uuid, p_search text, p_province text, p_contact text, p_page integer, p_selected uuid[]
) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  w uuid;
  result jsonb;
begin
  select workspace_id into w from public.koi_workspace_members where user_id = auth.uid();
  if w is null then raise exception 'Membership required' using errcode = '42501'; end if;
  if not exists(select 1 from public.koi_lead_lists where workspace_id = w and id = p_list) then
    raise exception 'List not found' using errcode = 'PT404';
  end if;

  with contacts as materialized (
    select l.id, l.name, l.phone, l.company, l.email,
      coalesce(location.province, '') as province,
      coalesce(location.city, '') as city,
      translate(lower(coalesce(location.province, '')), 'áéíóúü', 'aeiouu') as province_key,
      public_contact.last_at is not null as contacted,
      exists(select 1 from public.koi_suppressions s where s.workspace_id = w and s.phone = l.phone) as suppressed
    from public.koi_lead_list_members m
    join public.koi_leads l on l.id = m.lead_id and l.workspace_id = m.workspace_id and l.deleted_at is null
    left join lateral (
      select min(btrim(value)) filter (where field in ('province', 'provincia')) as province,
        min(btrim(value)) filter (where field in ('city', 'ciudad', 'localidad')) as city
      from (
        select lower(btrim(regexp_replace(key, '^\d+:', ''))) as field, value
        from jsonb_each_text(l.extra)
        where btrim(value) <> ''
      ) fields
    ) location on true
    cross join lateral (select koi_private.last_contact(w, l.id) as last_at) public_contact
    where m.workspace_id = w and m.list_id = p_list
  ), matching as materialized (
    select * from contacts c
    where (p_selected is null or c.id = any(p_selected))
      and (p_province = '' or (p_province = '__missing__' and c.province_key = '') or c.province_key = p_province)
      and (p_contact = 'all' or (p_contact = 'uncontacted' and not c.contacted) or (p_contact = 'contacted' and c.contacted))
      and (p_search = '' or strpos(lower(concat_ws(' ', c.name, c.company, c.email, c.city, c.province)), lower(p_search)) > 0
        or (regexp_replace(p_search, '\D', '', 'g') <> '' and p_search ~ '^[+0-9(). -]+$' and strpos(c.phone, regexp_replace(p_search, '\D', '', 'g')) > 0))
  )
  select jsonb_build_object(
    'total', (select count(*) from matching),
    'eligible', (select count(*) from matching where not suppressed),
    'provinces', coalesce((select jsonb_agg(to_jsonb(p) order by p.label) from (
      select province_key as key, min(province) as label from contacts where province_key <> '' group by province_key
    ) p), '[]'::jsonb),
    'hasMissingProvince', exists(select 1 from contacts where province_key = ''),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by lower(r.name), r.id) from (
      select id, name, phone, company, province, city, contacted, suppressed from matching
      order by lower(name), id limit 25 offset (greatest(1, least(coalesce(p_page, 1), 10000)) - 1) * 25
    ) r), '[]'::jsonb),
    'batchIds', coalesce((select jsonb_agg(r.id order by lower(r.name), r.id) from (
      select id, name from matching where not suppressed order by lower(name), id limit 100
    ) r), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.koi_campaign_recipient_picker(uuid,text,text,text,integer,uuid[]) from public, anon;
grant execute on function public.koi_campaign_recipient_picker(uuid,text,text,text,integer,uuid[]) to authenticated;
