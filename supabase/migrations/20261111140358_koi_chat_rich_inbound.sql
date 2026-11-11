begin;
alter table koi_private.chat_messages add column quote_provider_id text, add column quote_text text;

-- Keep the latest reaction, including a removal, even if its target has not arrived yet.
create table koi_private.chat_reactions (
  workspace_id uuid not null references public.koi_workspaces(id) on delete cascade,
  instance text not null,
  target_provider_id text not null,
  peer text not null,
  outbound boolean not null,
  emoji text not null,
  occurred_ms bigint not null,
  event_provider_id text not null,
  primary key(workspace_id,instance,target_provider_id,peer,outbound)
);
alter table koi_private.chat_reactions enable row level security;
revoke all on koi_private.chat_reactions from public,anon,authenticated;

create or replace function koi_private.chat_ingest(w uuid, account text, data jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare
  peer_id text:=data->>'peer'; phone_number text:=data->>'phone'; provider text:=data->>'providerId';
  c public.koi_conversations; lead uuid; assignee uuid; delivery_state text; message_time timestamptz;
  outbound boolean:=coalesce((data->>'outbound')::boolean,false);
  ranks text[]:=array['error','sent','delivered','read'];
begin
  if not exists(select 1 from koi_private.chat_instances(w) i where i.instance=account) then raise exception 'Unknown instance' using errcode='42501'; end if;
  if coalesce(char_length(provider),0) not between 1 and 200 then raise exception 'Invalid message ID' using errcode='22023'; end if;
  if data->>'kind'='receipt' then
    delivery_state:=data->>'delivery';
    insert into koi_private.chat_receipts values(w,account,provider,delivery_state)
    on conflict(workspace_id,instance,provider_id) do update set delivery=excluded.delivery
    where array_position(ranks,excluded.delivery)>array_position(ranks,koi_private.chat_receipts.delivery);
    update koi_private.chat_messages set delivery=delivery_state where workspace_id=w and instance=account and provider_id=provider
    and direction='out' and array_position(ranks,delivery_state)>coalesce(array_position(ranks,delivery),0);
    return '{"stored":true}';
  end if;
  if data->>'kind'='reaction' then
    if coalesce(peer_id,'') !~ '^[0-9]{1,25}@(s\.whatsapp\.net|lid)$'
      or coalesce(char_length(data->>'targetId'),0) not between 1 and 200
      or data->>'emoji' is null or char_length(data->>'emoji')>64
      or coalesce((data->>'occurredMs')::bigint,-1) not between 0 and 4102444800000 then
      raise exception 'Invalid reaction' using errcode='22023';
    end if;
    insert into koi_private.chat_reactions as r (workspace_id,instance,peer,target_provider_id,outbound,emoji,occurred_ms,event_provider_id)
    values(w,account,peer_id,data->>'targetId',outbound,data->>'emoji',(data->>'occurredMs')::bigint,provider)
    on conflict on constraint chat_reactions_pkey do update set
      emoji=excluded.emoji,occurred_ms=excluded.occurred_ms,event_provider_id=excluded.event_provider_id
    where (excluded.occurred_ms,excluded.event_provider_id)>(r.occurred_ms,r.event_provider_id);
    return '{"stored":true}';
  end if;
  if data->>'kind' is distinct from 'message' or coalesce(peer_id,'') !~ '^[0-9]{1,25}@(s\.whatsapp\.net|lid)$' then
    raise exception 'Invalid message' using errcode='22023';
  end if;
  if exists(select 1 from koi_private.chat_messages where workspace_id=w and instance=account and provider_id=provider) then return '{"stored":true}'; end if;
  select id,assigned_to into lead,assignee from public.koi_leads where workspace_id=w and id=koi_private.match_chat_lead(w,phone_number) and deleted_at is null for update;
  message_time:=least(now(),coalesce((data->>'sentAt')::timestamptz,now()));
  insert into public.koi_conversations(workspace_id,instance,peer,phone,name,lead_id,assigned_to,updated_at)
  values(w,account,peer_id,phone_number,left(coalesce(data->>'name',''),120),lead,assignee,message_time)
  on conflict(workspace_id,instance,peer) do update set lead_id=coalesce(koi_conversations.lead_id,excluded.lead_id), phone=coalesce(excluded.phone,koi_conversations.phone),
    name=coalesce(nullif(excluded.name,''),koi_conversations.name) returning * into c;
  select delivery into delivery_state from koi_private.chat_receipts where workspace_id=w and instance=account and provider_id=provider;
  insert into koi_private.chat_messages(workspace_id,conversation_id,instance,direction,body,sent_at,historical,status,provider_id,delivery,attachment_name,attachment_mime,quote_provider_id,quote_text)
  values(w,c.id,account,case when outbound then 'out' else 'in' end,left(coalesce(data->>'text',''),10000),message_time,coalesce((data->>'historical')::boolean,false),
    case when outbound then 'accepted' else 'received' end,provider,case when outbound then delivery_state end,
    left(data->>'fileName',120),data->>'mime',left(data->>'quoteId',200),left(data->>'quoteText',250)) on conflict(workspace_id,instance,provider_id) do nothing;
  if not outbound and not coalesce((data->>'historical')::boolean,false) and phone_number is not null and lower(btrim(data->>'text')) in ('baja','stop','no me contacten','no me escriban más','no me escriban mas') then
    insert into public.koi_suppressions(workspace_id,phone,reason) select w,p,'Baja solicitada por WhatsApp' from (
      select phone_number as p union select l.phone from public.koi_leads l where l.id=c.lead_id and l.workspace_id=w
    ) phones on conflict do nothing;
    update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=w and (phone=phone_number or lead_id=c.lead_id) and status in ('queued','leased');
  end if;
  return '{"stored":true}';
end $$;

create or replace function koi_private.chat_message_json(message koi_private.chat_messages) returns jsonb
language sql stable set search_path='' as $$
  select (to_jsonb(message) - array['workspace_id','instance','lease_token','lease_until','request_id','request_hash','retry_at','attempted_at','provider_id','quote_provider_id','quote_text'])
    || jsonb_build_object(
      'quote',case when message.quote_provider_id is not null then jsonb_build_object(
        'message_id',original.id,'text',coalesce(nullif(left(original.body,250),''),message.quote_text,original.attachment_name)
      ) end,
      'reactions',coalesce((select jsonb_agg(jsonb_build_object('emoji',r.emoji,'outbound',r.outbound) order by r.outbound)
        from koi_private.chat_reactions r join public.koi_conversations c on c.id=message.conversation_id and c.workspace_id=r.workspace_id
        where r.workspace_id=message.workspace_id and r.instance=message.instance and r.target_provider_id=message.provider_id
          and r.peer=c.peer and r.emoji<>''),'[]'::jsonb))
  from (select 1) anchor
  left join koi_private.chat_messages original on original.workspace_id=message.workspace_id and original.instance=message.instance
    and original.provider_id=message.quote_provider_id and original.conversation_id=message.conversation_id
$$;
commit;
