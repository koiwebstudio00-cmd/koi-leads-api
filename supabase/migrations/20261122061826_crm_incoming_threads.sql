begin;

create index koi_crm_evolution_inbound on koi_private.chat_messages(conversation_id,sent_at desc) where direction='in';

create index koi_crm_zernio_inbound on koi_private.inbox_messages(workspace_id,conversation_id,sent_at desc) where direction='in';

-- Called only by the scoped CRM reader below.
create function koi_private.crm_threads(w uuid, contact uuid)
returns table(lead_id uuid, id uuid, provider text, channel text, account text, label text, activity timestamptz, inbound timestamptz)
language sql stable set search_path='' as $$
  select c.lead_id,c.id,'evolution','whatsapp','evolution:'||a.id,a.label,
    coalesce((select max(m.sent_at) from koi_private.chat_messages m where m.conversation_id=c.id and m.workspace_id=w),c.updated_at),
    (select max(m.sent_at) from koi_private.chat_messages m where m.conversation_id=c.id and m.workspace_id=w and m.direction='in')
  from public.koi_conversations c join koi_private.chat_instances(w) a on a.instance=c.instance
  where c.workspace_id=w and c.deleted_at is null and c.lead_id is not null and (contact is null or c.lead_id=contact)
    and exists(select 1 from koi_private.chat_messages m where m.workspace_id=w and m.conversation_id=c.id)
  union all
  select c.lead_id,c.id,a.provider,c.channel,'zernio:'||a.id,a.label,
    coalesce((select max(m.sent_at) from koi_private.inbox_messages m where m.workspace_id=w and m.conversation_id=c.id),c.updated_at),
    (select max(m.sent_at) from koi_private.inbox_messages m where m.workspace_id=w and m.conversation_id=c.id and m.direction='in')
  from public.koi_inbox_conversations c join public.koi_inbox_accounts a on a.workspace_id=c.workspace_id and a.id=c.account_id
  where c.workspace_id=w and (contact is null or c.lead_id=contact)
$$;
revoke all on function koi_private.crm_threads(uuid,uuid) from public,anon,authenticated;

create function koi_private.crm_chat_read(action text,p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  w uuid;
  contact uuid;
  result jsonb;
  first_row integer := 1;
begin
  select workspace_id into strict w from public.koi_workspace_members where user_id=auth.uid();
  if action='accounts' then
    select coalesce(jsonb_agg(to_jsonb(a) order by channel,label,id),'[]') into result from (
      select 'evolution:'||i.id as id,'whatsapp' as channel,i.label from koi_private.chat_instances(w) i
      union all
      select 'zernio:'||a.id,a.channel,a.label from public.koi_inbox_accounts a where a.workspace_id=w
    ) a;
    return result;
  elsif action='threads' then
    select id into contact from public.koi_leads where workspace_id=w and id=(p->>'id')::uuid and deleted_at is null;
    if contact is null then raise exception 'Contact not found' using errcode='PT404'; end if;
    select coalesce(jsonb_agg(to_jsonb(t)-'lead_id' order by activity desc,id),'[]') into result from koi_private.crm_threads(w,contact) t;
    return result;
  elsif action not in ('board','list') or action is null then
    raise exception 'Invalid action' using errcode='22023';
  end if;
  if action='list' then first_row:=1+30*(greatest(1,least(coalesce((p->>'page')::int,1),100000))-1); end if;
  with latest as (
    select distinct on (t.lead_id) t.* from koi_private.crm_threads(w,null) t
    where t.inbound is not null and (nullif(p->>'channel','') is null or t.channel=p->>'channel')
      and (nullif(p->>'account','') is null or t.account=p->>'account')
    order by t.lead_id,t.inbound desc,t.id
  ), ranked as (
    select l as lead,t.inbound,t.channel,t.provider,t.label,t.id as thread_id,
      case when action='board' then l.stage else '' end as bucket,
      row_number() over(partition by case when action='board' then l.stage else '' end order by t.inbound desc,l.id) as pos
    from koi_private.crm_filtered(p) l join latest t on t.lead_id=l.id where l.workspace_id=w
  ), pages as (
    select bucket,count(*) as total,coalesce(jsonb_agg(to_jsonb(lead)||jsonb_build_object('incoming',
      jsonb_build_object('id',thread_id,'provider',provider,'channel',channel,'label',label,'at',inbound)) order by pos)
      filter(where pos between first_row and first_row+29),'[]') as leads from ranked group by bucket
  )
  select case when action='list' then coalesce((select to_jsonb(pg)-'bucket' from pages pg),'{"leads":[],"total":0}'::jsonb)
    else jsonb_build_object('columns',(select jsonb_agg(jsonb_build_object('stage',s,'leads',coalesce(pg.leads,'[]'),'total',coalesce(pg.total,0)) order by ord)
      from unnest(array['new','contacted','replied','interested','proposal','won','lost']) with ordinality stages(s,ord) left join pages pg on pg.bucket=s)) end into result;
  return result;
exception when no_data_found then raise exception 'Workspace required' using errcode='42501';
end $$;
create function public.koi_crm_chat_read(action text,p jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$select koi_private.crm_chat_read(action,p)$$;
revoke all on function koi_private.crm_chat_read(text,jsonb),public.koi_crm_chat_read(text,jsonb) from public,anon;
grant execute on function koi_private.crm_chat_read(text,jsonb),public.koi_crm_chat_read(text,jsonb) to authenticated;
commit;
