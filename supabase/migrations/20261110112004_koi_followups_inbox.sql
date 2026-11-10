begin;
-- A lead owns the assignment; a conversation without a lead may still be assigned.
create function koi_private.sync_lead_owner() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null and not exists(select 1 from public.koi_workspace_members where user_id=auth.uid() and workspace_id=new.workspace_id) then raise exception 'Membership required' using errcode='42501'; end if;
 update public.koi_conversations set assigned_to=new.assigned_to where lead_id=new.id and workspace_id=new.workspace_id and assigned_to is distinct from new.assigned_to;
 return new;
end $$;
revoke all on function koi_private.sync_lead_owner() from public,anon,authenticated;
create trigger koi_lead_owner_sync after update of assigned_to on public.koi_leads for each row when(old.assigned_to is distinct from new.assigned_to) execute function koi_private.sync_lead_owner();
create function koi_private.inherit_lead_owner() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.lead_id is not null then
  select assigned_to into new.assigned_to from public.koi_leads where id=new.lead_id and workspace_id=new.workspace_id;
  if not found then raise exception 'Invalid lead' using errcode='23503'; end if;
 end if;
 return new;
end $$;
revoke all on function koi_private.inherit_lead_owner() from public,anon,authenticated;
create trigger koi_chat_owner_inherit before insert or update of lead_id on public.koi_conversations for each row execute function koi_private.inherit_lead_owner();
update public.koi_conversations c set assigned_to=l.assigned_to from public.koi_leads l where c.lead_id=l.id and c.workspace_id=l.workspace_id and c.assigned_to is distinct from l.assigned_to;

-- Nonhistorical inbound messages advance only the first two stages. Opt-outs are not interest.
create function koi_private.lead_replied() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.direction='in' and not new.historical and new.status='received' and lower(btrim(new.body)) not in ('baja','stop','no me contacten','no me escriban más','no me escriban mas') then
  update public.koi_leads l set stage='replied' from public.koi_conversations c
  where c.id=new.conversation_id and c.workspace_id=new.workspace_id and l.id=c.lead_id and l.workspace_id=c.workspace_id and l.deleted_at is null and l.stage in ('new','contacted')
   and not exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone=l.phone);
 end if;
 return new;
end $$;
revoke all on function koi_private.lead_replied() from public,anon,authenticated;
create trigger koi_lead_replied after insert on koi_private.chat_messages for each row execute function koi_private.lead_replied();

-- Private message tables stay private. Only contact timestamps are exposed after membership validation.
create function koi_private.last_contact(w uuid,lid uuid) returns timestamptz language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.koi_workspace_members where workspace_id=w and user_id=auth.uid()) then raise exception 'Membership required' using errcode='42501'; end if;
 return (select max(at) from (
  select coalesce((select max(a.finished_at) from koi_private.message_attempts a where a.recipient_id=r.id and a.outcome='accepted'),r.updated_at) as at from public.koi_campaign_recipients r where r.workspace_id=w and r.lead_id=lid and r.status='accepted'
  union all select coalesce(m.attempted_at,m.sent_at) from koi_private.chat_messages m join public.koi_conversations c on c.id=m.conversation_id and c.workspace_id=m.workspace_id where c.workspace_id=w and c.lead_id=lid and m.direction='out' and m.status='accepted'
 ) sent);
end $$;
revoke all on function koi_private.last_contact(uuid,uuid) from public,anon,authenticated;
grant execute on function koi_private.last_contact(uuid,uuid) to authenticated;

-- Pending reply means latest live inbound is newer than every accepted outbound.
create function koi_private.chat_needs_reply(cid uuid) returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce((select m.direction='in' from koi_private.chat_messages m where m.conversation_id=cid and not m.historical and (m.direction='in' or m.status='accepted') order by m.sent_at desc,m.seq desc limit 1),false)
$$;
revoke all on function koi_private.chat_needs_reply(uuid) from public,anon,authenticated;

create table public.koi_followups(
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, lead_id uuid not null,
 title text not null check(length(btrim(title)) between 1 and 500), due_at timestamptz,
 status text not null default 'pending' check(status in ('pending','completed')),
 revision integer not null default 0, created_at timestamptz not null default now(),
 completed_at timestamptz, created_by uuid not null default auth.uid() references auth.users(id), request_id uuid not null,
 foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id), unique(workspace_id,request_id)
);
create index koi_followups_due on public.koi_followups(workspace_id,status,due_at,id);
create index koi_followups_lead on public.koi_followups(workspace_id,lead_id,status);
create index koi_followups_actor on public.koi_followups(created_by);
alter table public.koi_followups enable row level security;
revoke all on public.koi_followups from public,anon,authenticated;
grant select on public.koi_followups to authenticated;
grant insert(workspace_id,lead_id,title,due_at,request_id) on public.koi_followups to authenticated;
grant update(title,due_at,status) on public.koi_followups to authenticated;
create policy member_read on public.koi_followups for select to authenticated using(exists(select 1 from public.koi_workspace_members where user_id=(select auth.uid()) and workspace_id=koi_followups.workspace_id));
create policy member_create on public.koi_followups for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.koi_leads where id=koi_followups.lead_id and workspace_id=koi_followups.workspace_id and deleted_at is null));
create policy member_update on public.koi_followups for update to authenticated using(exists(select 1 from public.koi_leads where id=koi_followups.lead_id and workspace_id=koi_followups.workspace_id and deleted_at is null)) with check(exists(select 1 from public.koi_leads where id=koi_followups.lead_id and workspace_id=koi_followups.workspace_id and deleted_at is null));
create function koi_private.followup_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.title:=btrim(new.title); new.revision:=old.revision+1;
 new.completed_at:=case when new.status='completed' then coalesce(old.completed_at,now()) end;
 return new;
end $$;
create trigger koi_followup_revision before update on public.koi_followups for each row execute function koi_private.followup_revision();
-- The existing next-action fields remain a summary of the earliest pending task.
create function koi_private.followup_summary() returns trigger language plpgsql security invoker set search_path='' as $$
declare t public.koi_followups;
begin
 perform 1 from public.koi_leads where id=new.lead_id and workspace_id=new.workspace_id for update;
 select * into t from public.koi_followups where lead_id=new.lead_id and workspace_id=new.workspace_id and status='pending' order by due_at nulls last,created_at,id limit 1;
 update public.koi_leads set next_action=coalesce(t.title,''),next_action_at=t.due_at where id=new.lead_id and workspace_id=new.workspace_id;
 return new;
end $$;
create trigger koi_followup_summary after insert or update on public.koi_followups for each row execute function koi_private.followup_summary();
revoke all on function koi_private.followup_revision(),koi_private.followup_summary() from public,anon,authenticated;
insert into public.koi_followups(workspace_id,lead_id,title,due_at,created_by,request_id)
 select workspace_id,id,next_action,next_action_at,created_by,gen_random_uuid() from public.koi_leads where deleted_at is null and btrim(next_action)<>'';

create function koi_private.followup_command(action text,data jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare w uuid; t public.koi_followups; l public.koi_leads; result jsonb; n integer; view_name text:=coalesce(data->>'view','pending');
 today timestamptz:=date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman';
begin
 select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
 if w is null then raise exception 'Membership required' using errcode='42501'; end if;
 if action='tasks' then
  if view_name not in ('pending','today','overdue','completed') then raise exception 'Invalid view' using errcode='22023'; end if;
  with filtered as (
   select f.*,contact.name as lead_name,contact.phone,contact.assigned_to from public.koi_followups f join public.koi_leads contact on contact.id=f.lead_id and contact.workspace_id=f.workspace_id
   where f.workspace_id=w and contact.deleted_at is null
    and (coalesce(data->>'leadId','')='' or f.lead_id=(data->>'leadId')::uuid)
    and (coalesce(data->>'owner','all')='all' or (data->>'owner'='mine' and contact.assigned_to=auth.uid()) or (data->>'owner'='unassigned' and contact.assigned_to is null))
    and (case view_name when 'completed' then f.status='completed' when 'today' then f.status='pending' and f.due_at>=today and f.due_at<today+interval '1 day' when 'overdue' then f.status='pending' and f.due_at<now() else f.status='pending' end)
    and (coalesce(data->>'search','')='' or strpos(lower(concat_ws(' ',f.title,contact.name,contact.phone)),lower(data->>'search'))>0)
  ), page as (select * from filtered order by due_at nulls last,created_at,id limit 30 offset (greatest(1,least(100000,coalesce((data->>'page')::integer,1)))-1)*30)
  select jsonb_build_object('tasks',coalesce((select jsonb_agg(to_jsonb(page) order by due_at nulls last,created_at,id) from page),'[]'),'total',(select count(*) from filtered)) into result;
  return result;
 end if;
 if action='task_create' then
  select * into l from public.koi_leads where id=(data->>'leadId')::uuid and workspace_id=w and deleted_at is null for update;
  if not found then raise exception 'Lead missing' using errcode='PT404'; end if;
  insert into public.koi_followups(workspace_id,lead_id,title,due_at,request_id) values(w,l.id,btrim(data->>'title'),(data->>'dueAt')::timestamptz,(data->>'key')::uuid) on conflict(workspace_id,request_id) do nothing;
  select * into t from public.koi_followups where workspace_id=w and request_id=(data->>'key')::uuid;
  if t.lead_id<>l.id or t.created_by<>auth.uid() or t.title<>btrim(data->>'title') or t.due_at is distinct from (data->>'dueAt')::timestamptz then raise exception 'Task conflict' using errcode='PT409'; end if;
 elsif action='task_update' then
  select * into t from public.koi_followups where id=(data->>'id')::uuid and workspace_id=w;
  if not found then raise exception 'Task missing' using errcode='PT404'; end if;
  perform 1 from public.koi_leads where id=t.lead_id and workspace_id=w and deleted_at is null for update;
  if not found then raise exception 'Lead missing' using errcode='PT404'; end if;
  update public.koi_followups set title=case when data?'title' then btrim(data->>'title') else title end,due_at=case when data?'dueAt' then (data->>'dueAt')::timestamptz else due_at end,status=case when data?'status' then data->>'status' else status end
   where id=t.id and revision=(data->>'revision')::integer returning * into t;
  if not found then raise exception 'Stale task' using errcode='PT409'; end if;
 else raise exception 'Unknown action' using errcode='22023'; end if;
 return to_jsonb(t);
end $$;
revoke all on function koi_private.followup_command(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.followup_command(text,jsonb) to authenticated;

create or replace function koi_private.chat_command(action text, data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); w uuid; member_role text;
  c public.koi_conversations; l public.koi_leads; m koi_private.chat_messages;
  instance_name text; query text:=left(coalesce(data->>'search',''),100);
  page integer:=greatest(1,least(10000,coalesce((data->>'page')::integer,1)));
  body text:=btrim(coalesce(data->>'text','')); file_bytes bytea;
  file_name text:=data->>'fileName'; mime text:=data->>'mime';
  key uuid; assignment uuid; fingerprint text;
begin
  select workspace_id,role into w,member_role from public.koi_workspace_members where user_id=actor;
  if actor is null or w is null or member_role not in ('admin','operator') then
    raise exception 'Membership required' using errcode='42501';
  end if;
  if action='accounts' then
    return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'label',i.label) order by i.id<>'primary',i.label) from koi_private.chat_instances(w) i),'[]');
  end if;
  if action='list' then
    return coalesce((select jsonb_agg(q.item order by q.updated_at desc,q.id) from (
      select x.id,x.updated_at,koi_private.chat_row(x,actor) item
      from public.koi_conversations x
      left join public.koi_leads lead on lead.id=x.lead_id and lead.workspace_id=w and lead.deleted_at is null
      left join koi_private.chat_reads seen on seen.conversation_id=x.id and seen.user_id=actor
      where x.workspace_id=w and x.archived=coalesce((data->>'archived')::boolean,false)
      and (coalesce(data->>'owner','all')='all' or (data->>'owner'='mine' and x.assigned_to=actor) or (data->>'owner'='unassigned' and x.assigned_to is null))
      and (not coalesce((data->>'pendingReply')::boolean,false) or (koi_private.chat_needs_reply(x.id) and not exists(select 1 from public.koi_suppressions s where s.workspace_id=w and s.phone=x.phone)))
      and (query='' or strpos(lower(concat_ws(' ',lead.name,x.name,x.phone)),lower(query))>0)
      and (coalesce(data->>'instanceId','')='' or x.instance=(select i.instance from koi_private.chat_instances(w) i where i.id=data->>'instanceId'))
      and (not coalesce((data->>'unread')::boolean,false) or exists(select 1 from koi_private.chat_messages incoming where incoming.conversation_id=x.id and incoming.direction='in' and not incoming.historical and incoming.seq>coalesce(seen.last_seq,0)))
      order by x.updated_at desc,x.id limit 40 offset (page-1)*40
    ) q),'[]');
  end if;
  if action='open' then
    select i.instance into instance_name from koi_private.chat_instances(w) i where i.id=data->>'instanceId';
    select * into l from public.koi_leads where id=(data->>'leadId')::uuid and workspace_id=w and deleted_at is null for update;
    if instance_name is null or l.id is null then raise exception 'Lead or instance missing' using errcode='PT404'; end if;
    insert into public.koi_conversations(workspace_id,instance,peer,phone,name,lead_id,assigned_to)
    values(w,instance_name,l.phone||'@s.whatsapp.net',l.phone,l.name,l.id,l.assigned_to)
    on conflict(workspace_id,instance,peer) do update set lead_id=excluded.lead_id,archived=false returning * into c;
    return koi_private.chat_row(c,actor);
  end if;
  select * into c from public.koi_conversations where id=(data->>'id')::uuid and workspace_id=w;
  if not found then raise exception 'Chat not found' using errcode='PT404'; end if;

  if action='history_target' then return jsonb_build_object('instance',c.instance,'peer',c.peer); end if;
  if action='detail' then
    return jsonb_build_object('conversation',koi_private.chat_row(c,actor),'messages',coalesce((
      select jsonb_agg(koi_private.chat_message_json(q) order by q.sent_at,q.seq) from (
        select * from koi_private.chat_messages where conversation_id=c.id
        and (data->>'before' is null or (sent_at,seq)<(select previous.sent_at,previous.seq from koi_private.chat_messages previous where previous.seq=(data->>'before')::bigint and previous.conversation_id=c.id))
        order by sent_at desc,seq desc limit 50
      ) q
    ),'[]'));
  end if;
  if action='read' then
    insert into koi_private.chat_reads(conversation_id,user_id,last_seq)
    select c.id,actor,coalesce(max(seq),0) from koi_private.chat_messages where conversation_id=c.id and seq<=(data->>'through')::bigint
    on conflict(conversation_id,user_id) do update set last_seq=greatest(koi_private.chat_reads.last_seq,excluded.last_seq);
    return '{"ok":true}';
  end if;
  if action='update' then
    assignment:=(data->>'assignedTo')::uuid;
    if assignment is not null and not exists(select 1 from public.koi_workspace_members where workspace_id=w and user_id=assignment) then
      raise exception 'Invalid assignee' using errcode='42501';
    end if;
    if data?'assignedTo' and c.lead_id is not null then
      update public.koi_leads set assigned_to=assignment where id=c.lead_id and workspace_id=w and deleted_at is null and assigned_to is distinct from assignment;
    end if;
    update public.koi_conversations set archived=coalesce((data->>'archived')::boolean,archived),
      assigned_to=case when data?'assignedTo' then assignment else assigned_to end where id=c.id returning * into c;
    return koi_private.chat_row(c,actor);
  end if;
  if action='resolve' then
    if member_role<>'admin' then raise exception 'Admin required' using errcode='42501'; end if;
    perform 1 from koi_private.senders where workspace_id=w for update;
    update koi_private.chat_messages set status='closed',lease_token=null,lease_until=null
    where conversation_id=c.id and id=(data->>'messageId')::uuid and status='unknown';
    if not found then raise exception 'Result already reviewed' using errcode='PT409'; end if;
    return '{"ok":true}';
  end if;
  if action='attachment' then
    select * into m from koi_private.chat_messages where conversation_id=c.id and id=(data->>'messageId')::uuid and attachment_mime is not null;
    if not found then raise exception 'Attachment not found' using errcode='PT404'; end if;
    return jsonb_build_object('filename',m.attachment_name,'mime',m.attachment_mime,'providerId',m.provider_id,
      'instance',c.instance,'base64',(select replace(encode(content,'base64'),chr(10),'') from koi_private.chat_files where message_id=m.id));
  end if;
  if action<>'send' then raise exception 'Invalid action' using errcode='22023'; end if;
  key:=(data->>'key')::uuid;
  if key is null or char_length(body)>4000 or (body='' and mime is null) then raise exception 'Invalid message' using errcode='22023'; end if;
  if mime is not null then
    if mime not in ('image/jpeg','image/png','application/pdf','audio/ogg','audio/mpeg','audio/mp4') or (mime like 'audio/%' and body<>'') or coalesce(char_length(file_name),0) not between 1 and 120
       or coalesce(char_length(data->>'base64'),0) not between 1 and 5592408 then raise exception 'Invalid attachment' using errcode='22023'; end if;
    file_bytes:=decode(data->>'base64','base64');
  end if;
  fingerprint:=md5(data::text);
  -- Serializa el alta con el worker, las bajas y los reintentos del operador.
  perform 1 from koi_private.senders where workspace_id=w for update;
  if not found then raise exception 'Sender not configured' using errcode='PT503'; end if;
  select * into m from koi_private.chat_messages where workspace_id=w and actor_id=actor and request_id=key;
  if found then
    if m.request_hash<>fingerprint then raise exception 'Request already used' using errcode='PT409'; end if;
    return koi_private.chat_message_json(m);
  end if;
  if c.phone is null or exists(select 1 from public.koi_suppressions where workspace_id=w and phone=c.phone)
    or (c.lead_id is not null and not exists(select 1 from public.koi_leads where id=c.lead_id and workspace_id=w and deleted_at is null and phone=c.phone)) then
    raise exception 'Contact unavailable' using errcode='PT409';
  end if;
  insert into koi_private.chat_messages(workspace_id,conversation_id,instance,direction,body,status,actor_id,request_id,request_hash,attachment_name,attachment_mime)
  values(w,c.id,c.instance,'out',body,'queued',actor,key,fingerprint,file_name,mime) returning * into m;
  if file_bytes is not null then insert into koi_private.chat_files values(m.id,file_bytes); end if;
  return koi_private.chat_message_json(m);
end $$;
create or replace function koi_private.chat_row(c public.koi_conversations, actor uuid) returns jsonb
language sql stable set search_path='' as $$
  select (to_jsonb(c)-'workspace_id'-'peer'-'instance') || jsonb_build_object(
    'lead_id',l.id,'name',coalesce(nullif(l.name,''),nullif(c.name,''),c.phone,'Contacto de WhatsApp'),
    'product',l.product,'stage',l.stage,'company',l.company,
    'instance_label',i.label,'instance_id',i.id,
    'suppressed',exists(select 1 from public.koi_suppressions s where s.workspace_id=c.workspace_id and s.phone=c.phone),
    'unread',(select count(*) from koi_private.chat_messages m where m.conversation_id=c.id and m.direction='in' and not m.historical and m.seq>coalesce(r.last_seq,0)),
    'pending_reply',koi_private.chat_needs_reply(c.id) and not exists(select 1 from public.koi_suppressions s where s.workspace_id=c.workspace_id and s.phone=c.phone),'last_message',koi_private.chat_message_json(last_message)
  )
  from koi_private.chat_instances(c.workspace_id) i
  left join public.koi_leads l on l.id=c.lead_id and l.workspace_id=c.workspace_id and l.deleted_at is null
  left join koi_private.chat_reads r on r.conversation_id=c.id and r.user_id=actor
  left join lateral (select m.* from koi_private.chat_messages m where m.conversation_id=c.id order by m.sent_at desc,m.seq desc limit 1) last_message on true
  where i.instance=c.instance
$$;
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
  if data->>'kind' is distinct from 'message' or coalesce(peer_id,'') !~ '^[0-9]{1,25}@(s\.whatsapp\.net|lid)$' then
    raise exception 'Invalid message' using errcode='22023';
  end if;
  if exists(select 1 from koi_private.chat_messages where workspace_id=w and instance=account and provider_id=provider) then return '{"stored":true}'; end if;
  select id,assigned_to into lead,assignee from public.koi_leads where workspace_id=w and phone=phone_number and deleted_at is null for update;
  message_time:=least(now(),coalesce((data->>'sentAt')::timestamptz,now()));
  insert into public.koi_conversations(workspace_id,instance,peer,phone,name,lead_id,assigned_to,updated_at)
  values(w,account,peer_id,phone_number,left(coalesce(data->>'name',''),120),lead,assignee,message_time)
  on conflict(workspace_id,instance,peer) do update set lead_id=coalesce(excluded.lead_id,koi_conversations.lead_id),
    name=coalesce(nullif(excluded.name,''),koi_conversations.name) returning * into c;
  select delivery into delivery_state from koi_private.chat_receipts where workspace_id=w and instance=account and provider_id=provider;
  insert into koi_private.chat_messages(workspace_id,conversation_id,instance,direction,body,sent_at,historical,status,provider_id,delivery,attachment_name,attachment_mime)
  values(w,c.id,account,case when outbound then 'out' else 'in' end,left(coalesce(data->>'text',''),10000),message_time,coalesce((data->>'historical')::boolean,false),
    case when outbound then 'accepted' else 'received' end,provider,case when outbound then delivery_state end,
    left(data->>'fileName',120),data->>'mime') on conflict(workspace_id,instance,provider_id) do nothing;
  if not outbound and not coalesce((data->>'historical')::boolean,false) and phone_number is not null and lower(btrim(data->>'text')) in ('baja','stop','no me contacten','no me escriban más','no me escriban mas') then
    insert into public.koi_suppressions(workspace_id,phone,reason) values(w,phone_number,'Baja solicitada por WhatsApp') on conflict do nothing;
    update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=w and phone=phone_number and status in ('queued','leased');
  end if;
  return '{"stored":true}';
end $$;
create or replace function public.koi_crm_command(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare w uuid; l public.koi_leads; result jsonb; cols jsonb:='[]'; s text; n integer; offset_n integer:=greatest(0,least(coalesce((p_data->>'page')::integer,1),100000)-1)*30; note public.koi_lead_notes;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
 if w is null then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_action in ('tasks','task_create','task_update') then return koi_private.followup_command(p_action,p_data); end if;
 if p_action in ('create','bulk') then return public.koi_manage_leads(p_action,p_data);
 elsif p_action='options' then
  return jsonb_build_object('members',koi_private.crm_members(),
   'lists',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.koi_lead_lists where workspace_id=w),'[]'),
   'tags',coalesce((select jsonb_agg(t order by t) from (select distinct unnest(tags) t from public.koi_leads where workspace_id=w) x),'[]'));
 elsif p_action='summary' then
 return jsonb_build_object('leads',(select count(*) from public.koi_leads where workspace_id=w and deleted_at is null),'contacted',(select count(*) from public.koi_leads contact where contact.workspace_id=w and contact.deleted_at is null and koi_private.last_contact(w,contact.id) is not null),'campaigns',(select coalesce(jsonb_object_agg(c.status,c.n),'{}') from (select status,count(*) n from public.koi_campaigns where workspace_id=w group by status) c));
 elsif p_action='list' then
  select count(*) into n from koi_private.crm_filtered(p_data);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id),'[]') into result from (select * from koi_private.crm_filtered(p_data) order by created_at desc,id limit 30 offset offset_n) q;
  return jsonb_build_object('leads',result,'total',n);
 elsif p_action='board' then
  foreach s in array array['new','contacted','replied','interested','proposal','won','lost'] loop
   select count(*) into n from koi_private.crm_filtered(p_data) f where f.stage=s;
   select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id),'[]') into result from (select * from koi_private.crm_filtered(p_data) f where f.stage=s order by created_at desc,id limit 30) q;
   cols:=cols||jsonb_build_array(jsonb_build_object('stage',s,'total',n,'leads',result));
  end loop;
  return jsonb_build_object('columns',cols);
 end if;
 select * into l from public.koi_leads where id=(p_data->>'id')::uuid and workspace_id=w and deleted_at is null;
 if not found then raise exception 'Contact not found' using errcode='PT404'; end if;
 if p_action='detail' then
  return jsonb_build_object('lead',to_jsonb(l),'lists',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.name) from public.koi_lead_lists b join public.koi_lead_list_members m on m.list_id=b.id where m.lead_id=l.id and m.workspace_id=w),'[]'),
   'suppressed',exists(select 1 from public.koi_suppressions where workspace_id=w and phone=l.phone),
   'lastContactAt',koi_private.last_contact(w,l.id));
 elsif p_action='update' then
  update public.koi_leads set
   product=case when p_data?'product' then p_data->>'product' else product end,
   stage=case when p_data?'stage' then p_data->>'stage' else stage end,
   tags=case when p_data?'tags' then array(select jsonb_array_elements_text(p_data->'tags')) else tags end,
   assigned_to=case when p_data?'assignedTo' then (p_data->>'assignedTo')::uuid else assigned_to end,
   next_action=case when p_data?'nextAction' then btrim(p_data->>'nextAction') else next_action end,
   next_action_at=case when p_data?'nextActionAt' then (p_data->>'nextActionAt')::timestamptz else next_action_at end
  where id=l.id and workspace_id=w and revision=(p_data->>'revision')::integer returning * into l;
  if not found then raise exception 'Stale contact' using errcode='PT409'; end if;
  return to_jsonb(l);
 elsif p_action='note' then
  select * into note from public.koi_lead_notes where workspace_id=w and request_id=(p_data->>'key')::uuid;
  if not found then
   insert into public.koi_lead_notes(workspace_id,lead_id,body,request_id) values(w,l.id,btrim(p_data->>'body'),(p_data->>'key')::uuid) on conflict(workspace_id,request_id) do nothing;
   select * into note from public.koi_lead_notes where workspace_id=w and request_id=(p_data->>'key')::uuid;
  end if;
  if note.lead_id<>l.id or note.body<>btrim(p_data->>'body') or note.actor_id<>auth.uid() then raise exception 'Note key conflict' using errcode='PT409'; end if;
  return to_jsonb(note);
 elsif p_action='notes' then
  return jsonb_build_object('total',(select count(*) from public.koi_lead_notes where lead_id=l.id and workspace_id=w),'notes',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id) from (select * from public.koi_lead_notes where lead_id=l.id and workspace_id=w order by created_at desc,id limit 30 offset offset_n) q),'[]'));
 elsif p_action='history' then
  return jsonb_build_object('total',(select count(*) from public.koi_campaign_recipients where lead_id=l.id and workspace_id=w),'history',coalesce((select jsonb_agg(to_jsonb(q) order by q.updated_at desc,q.id) from (select r.id,r.campaign_id,c.name as campaign_name,r.status,r.delivery,r.message,r.updated_at from public.koi_campaign_recipients r join public.koi_campaigns c on c.id=r.campaign_id where r.lead_id=l.id and r.workspace_id=w order by r.updated_at desc,r.id limit 30 offset offset_n) q),'[]'));
 end if;
 raise exception 'Unknown CRM action' using errcode='22023';
end $$;
-- Reconcile live replies already received; history, opt-outs and later stages remain untouched.
update public.koi_leads l set stage='replied' where l.deleted_at is null and l.stage in ('new','contacted')
 and not exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone=l.phone)
 and exists(select 1 from public.koi_conversations c join koi_private.chat_messages m on m.conversation_id=c.id and m.workspace_id=c.workspace_id where c.lead_id=l.id and c.workspace_id=l.workspace_id and m.direction='in' and not m.historical and m.status='received' and lower(btrim(m.body)) not in ('baja','stop','no me contacten','no me escriban más','no me escriban mas'));
commit;
