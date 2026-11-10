begin;

create table public.koi_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  channel text not null default 'whatsapp' check (channel = 'whatsapp'),
  instance text not null,
  peer text not null check (peer ~ '^[0-9]{1,25}@(s\.whatsapp\.net|lid)$'),
  phone text check (phone ~ '^[1-9][0-9]{9,14}$'),
  name text not null default '',
  lead_id uuid references public.koi_leads(id),
  assigned_to uuid references auth.users(id),
  archived boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (workspace_id, instance, peer)
);
create index koi_conversation_inbox on public.koi_conversations(workspace_id, archived, updated_at desc, id);
create index koi_conversation_lead on public.koi_conversations(lead_id);

create table koi_private.chat_messages (
  seq bigint generated always as identity unique,
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  conversation_id uuid not null references public.koi_conversations(id),
  instance text not null,
  direction text not null check (direction in ('in','out')),
  body text not null default '' check (char_length(body) <= 10000),
  sent_at timestamptz not null default now(),
  historical boolean not null default false,
  status text not null check (status in ('received','queued','leased','sending','accepted','failed','unknown','closed')),
  delivery text check (delivery in ('error','sent','delivered','read')),
  provider_id text check (char_length(provider_id) between 1 and 200),
  actor_id uuid references auth.users(id),
  request_id uuid,
  request_hash text,
  attachment_name text,
  attachment_mime text,
  lease_token uuid,
  lease_until timestamptz,
  attempted_at timestamptz,
  retry_at timestamptz not null default now(),
  unique (workspace_id, instance, provider_id),
  unique (workspace_id, actor_id, request_id)
);
create index koi_chat_history on koi_private.chat_messages(conversation_id,sent_at desc,seq desc);
create index koi_chat_unread on koi_private.chat_messages(conversation_id,seq) where direction='in' and not historical;
create index koi_chat_pending on koi_private.chat_messages(workspace_id,instance,retry_at,seq) where status in ('queued','leased','sending','unknown');
create index koi_chat_rate on koi_private.chat_messages(workspace_id,instance,attempted_at) where attempted_at is not null;
create table koi_private.chat_files (
  message_id uuid primary key references koi_private.chat_messages(id) on delete cascade,
  content bytea not null check (octet_length(content) between 1 and 4194304)
);
create table koi_private.chat_reads (
  conversation_id uuid not null references public.koi_conversations(id),
  user_id uuid not null references auth.users(id),
  last_seq bigint not null,
  primary key (conversation_id,user_id)
);
create table koi_private.chat_receipts (
  workspace_id uuid not null references public.koi_workspaces(id),
  instance text not null,
  provider_id text not null check (char_length(provider_id) between 1 and 200),
  delivery text not null check (delivery in ('error','sent','delivered','read')),
  primary key(workspace_id,instance,provider_id)
);

alter table public.koi_conversations enable row level security;
alter table koi_private.chat_messages enable row level security;
alter table koi_private.chat_files enable row level security;
alter table koi_private.chat_reads enable row level security;
alter table koi_private.chat_receipts enable row level security;
revoke all on public.koi_conversations, koi_private.chat_messages, koi_private.chat_files, koi_private.chat_reads, koi_private.chat_receipts from public,anon,authenticated;
grant select on public.koi_conversations to authenticated;
create policy koi_conversation_read on public.koi_conversations for select to authenticated using (
  exists(select 1 from public.koi_workspace_members member where member.workspace_id=koi_conversations.workspace_id and member.user_id=(select auth.uid()))
);
do $$ begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.koi_conversations;
  end if;
end $$;

create function koi_private.chat_message_json(message koi_private.chat_messages) returns jsonb
language sql stable set search_path='' as $$
  select to_jsonb(message) - array['workspace_id','instance','lease_token','lease_until','request_id','request_hash','retry_at','attempted_at','provider_id']
$$;

create function koi_private.chat_touch() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    update public.koi_conversations set updated_at=greatest(updated_at,new.sent_at),
      archived=case when new.direction='in' and new.sent_at>=updated_at then false else archived end where id=new.conversation_id;
  elsif new.status is distinct from old.status or new.delivery is distinct from old.delivery then
    -- Notifica el cambio sin alterar el orden de la bandeja.
    update public.koi_conversations set updated_at=updated_at where id=new.conversation_id;
  end if;
  return new;
end $$;
create trigger koi_chat_touch after insert or update on koi_private.chat_messages for each row execute function koi_private.chat_touch();

create function koi_private.chat_instances(w uuid) returns table(id text,instance text,label text)
language sql stable set search_path='' as $$
  select 'primary',s.instance,'Número de campañas' from koi_private.senders s where s.workspace_id=w
  union all
  select i.id::text,i.instance_name,i.label from public.koi_whatsapp_instances i where i.workspace_id=w
$$;

create function koi_private.chat_row(c public.koi_conversations, actor uuid) returns jsonb
language sql stable set search_path='' as $$
  select (to_jsonb(c)-'workspace_id'-'peer'-'instance') || jsonb_build_object(
    'lead_id',l.id,'name',coalesce(nullif(l.name,''),nullif(c.name,''),c.phone,'Contacto de WhatsApp'),
    'product',l.product,'stage',l.stage,'company',l.company,
    'instance_label',i.label,'instance_id',i.id,
    'suppressed',exists(select 1 from public.koi_suppressions s where s.workspace_id=c.workspace_id and s.phone=c.phone),
    'unread',(select count(*) from koi_private.chat_messages m where m.conversation_id=c.id and m.direction='in' and not m.historical and m.seq>coalesce(r.last_seq,0)),
    'last_message',koi_private.chat_message_json(last_message)
  )
  from koi_private.chat_instances(c.workspace_id) i
  left join public.koi_leads l on l.id=c.lead_id and l.workspace_id=c.workspace_id and l.deleted_at is null
  left join koi_private.chat_reads r on r.conversation_id=c.id and r.user_id=actor
  left join lateral (select m.* from koi_private.chat_messages m where m.conversation_id=c.id order by m.sent_at desc,m.seq desc limit 1) last_message on true
  where i.instance=c.instance
$$;

create function koi_private.chat_command(action text, data jsonb) returns jsonb
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
      and (query='' or strpos(lower(concat_ws(' ',lead.name,x.name,x.phone)),lower(query))>0)
      and (coalesce(data->>'instanceId','')='' or x.instance=(select i.instance from koi_private.chat_instances(w) i where i.id=data->>'instanceId'))
      and (not coalesce((data->>'unread')::boolean,false) or exists(select 1 from koi_private.chat_messages incoming where incoming.conversation_id=x.id and incoming.direction='in' and not incoming.historical and incoming.seq>coalesce(seen.last_seq,0)))
      order by x.updated_at desc,x.id limit 40 offset (page-1)*40
    ) q),'[]');
  end if;
  if action='open' then
    select i.instance into instance_name from koi_private.chat_instances(w) i where i.id=data->>'instanceId';
    select * into l from public.koi_leads where id=(data->>'leadId')::uuid and workspace_id=w and deleted_at is null;
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

create function public.koi_chat_command(action text,data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select koi_private.chat_command(action,data) $$;
revoke all on function koi_private.chat_command(text,jsonb),public.koi_chat_command(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.chat_command(text,jsonb),public.koi_chat_command(text,jsonb) to authenticated;

create function koi_private.chat_inflight(w uuid, account text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from koi_private.chat_messages m where m.workspace_id=w and m.instance=account and m.status in ('leased','sending','unknown'))
$$;

create function koi_private.sender_attempts(w uuid, account text, since timestamptz) returns bigint
language sql stable security definer set search_path='' as $$
  select (select count(*) from koi_private.chat_messages m where m.workspace_id=w and m.instance=account and m.attempted_at>since)
    + (select count(*) from koi_private.message_attempts a join koi_private.senders s on s.workspace_id=a.workspace_id where a.workspace_id=w and s.instance=account and a.started_at>since)
$$;

create function koi_private.chat_ingest(w uuid, account text, data jsonb) returns jsonb
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
  select id,assigned_to into lead,assignee from public.koi_leads where workspace_id=w and phone=phone_number and deleted_at is null;
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

create function koi_private.chat_machine(action text, data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  w uuid; binding text; sender koi_private.senders; c public.koi_conversations; m koi_private.chat_messages;
  account text:=data->>'instance'; provider text; outcome text; receipt text; event jsonb;
  day_start timestamptz:=date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman';
begin
  select workspace_id,kind into w,binding from koi_private.machine_bindings where role_name=session_user;
  if w is null then raise exception 'Unbound machine' using errcode='42501'; end if;
  select * into sender from koi_private.senders where workspace_id=w for update;
  if action in ('chat_ingest','chat_history') then
    if binding<>'webhook' then raise exception 'Webhook required' using errcode='42501'; end if;
    if action='chat_ingest' then return koi_private.chat_ingest(w,account,data); end if;
    if jsonb_typeof(data->'events') is distinct from 'array' or jsonb_array_length(data->'events')>50 then
      raise exception 'Invalid history page' using errcode='22023';
    end if;
    for event in select value from jsonb_array_elements(data->'events') loop
      perform koi_private.chat_ingest(w,account,event||'{"historical":true}'::jsonb);
    end loop;
    return '{"stored":true}';
  end if;
  if binding<>'worker' or account is distinct from sender.instance then raise exception 'Worker required' using errcode='42501'; end if;
  if action='chat_tick' then
    update koi_private.chat_messages set status=case when status='sending' then 'unknown' else 'queued' end,
      lease_token=case when status='sending' then lease_token end,lease_until=null
    where workspace_id=w and status in ('leased','sending') and lease_until<now();
    return '{"ok":true}';
  end if;
  if action='chat_claim' then
    if not sender.enabled then return null; end if;
    select q.* into m from koi_private.chat_messages q
    where q.workspace_id=w and q.status='queued' and q.retry_at<=now()
      and not koi_private.chat_inflight(w,q.instance)
      and (q.instance<>sender.instance or (not sender.blocked and sender.next_send_at<=now()
        and not exists(select 1 from public.koi_campaign_recipients r where r.workspace_id=w and r.status in ('leased','sending','unknown'))))
      and (q.instance=sender.instance or not exists(select 1 from koi_private.chat_messages x where x.workspace_id=w and x.instance=q.instance and x.attempted_at>now()-make_interval(secs=>sender.min_interval)))
      and koi_private.sender_attempts(w,q.instance,now()-interval '1 minute')<sender.max_minute
      and koi_private.sender_attempts(w,q.instance,now()-interval '1 hour')<sender.max_hour
      and koi_private.sender_attempts(w,q.instance,day_start)<sender.max_day
    order by q.seq limit 1 for update;
    if not found then return null; end if;
    update koi_private.chat_messages set status='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds'
      where id=m.id returning * into m;
    return jsonb_build_object('id',m.id,'token',m.lease_token,'instance',m.instance);
  end if;
  select * into m from koi_private.chat_messages where workspace_id=w and id=(data->>'id')::uuid for update;
  if not found or m.lease_token is null or m.lease_token is distinct from (data->>'token')::uuid then return null; end if;
  if action='chat_defer' and m.status='leased' then
    update koi_private.chat_messages set status='queued',retry_at=now()+interval '20 seconds',lease_token=null,lease_until=null where id=m.id;
    return null;
  end if;
  if action='chat_begin' and m.status='leased' and m.lease_until>now() then
    if not sender.enabled or (m.instance=sender.instance and sender.blocked) then return null; end if;
    select * into c from public.koi_conversations where id=m.conversation_id;
    if c.phone is null or exists(select 1 from public.koi_suppressions where workspace_id=w and phone=c.phone)
      or (c.lead_id is not null and not exists(select 1 from public.koi_leads where id=c.lead_id and workspace_id=w and deleted_at is null and phone=c.phone)) then
      update koi_private.chat_messages set status='failed',lease_token=null,lease_until=null where id=m.id;
      return null;
    end if;
    update koi_private.chat_messages set status='sending',attempted_at=now(),lease_until=now()+interval '90 seconds' where id=m.id;
    if m.instance=sender.instance then
      update koi_private.senders set next_send_at=now()+make_interval(secs=>sender.min_interval) where workspace_id=w;
    end if;
    return jsonb_build_object('phone',c.phone,'text',m.body,'mime',m.attachment_mime,'fileName',m.attachment_name,
      'base64',(select replace(encode(content,'base64'),chr(10),'') from koi_private.chat_files where message_id=m.id));
  end if;
  if action='chat_finish' and m.status in ('sending','unknown') then
    outcome:=data->>'outcome';
    provider:=data->>'providerId';
    if coalesce(outcome,'') not in ('accepted','failed','unknown') or (outcome='accepted' and coalesce(char_length(provider),0) not between 1 and 200) then
      raise exception 'Invalid outcome' using errcode='22023';
    end if;
    if outcome='accepted' then
      -- SEND_MESSAGE puede llegar antes de la respuesta HTTP de Evolution.
      delete from koi_private.chat_messages where workspace_id=w and instance=m.instance and provider_id=provider
        and actor_id is null and direction='out';
      select delivery into receipt from koi_private.chat_receipts where workspace_id=w and instance=m.instance and provider_id=provider;
      update public.koi_leads set stage='contacted' where id=(select lead_id from public.koi_conversations where id=m.conversation_id)
        and workspace_id=w and deleted_at is null and stage='new';
    end if;
    update koi_private.chat_messages set status=outcome,provider_id=case when outcome='accepted' then provider end,
      delivery=receipt,lease_until=null,lease_token=case when outcome='unknown' then lease_token end where id=m.id;
    return '{"ok":true}';
  end if;
  return null;
end $$;

revoke all on function koi_private.chat_message_json(koi_private.chat_messages),koi_private.chat_touch(),
  koi_private.chat_instances(uuid),koi_private.chat_row(public.koi_conversations,uuid),
  koi_private.chat_inflight(uuid,text),koi_private.sender_attempts(uuid,text,timestamptz),
  koi_private.chat_ingest(uuid,text,jsonb),koi_private.chat_machine(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.chat_inflight(uuid,text),koi_private.sender_attempts(uuid,text,timestamptz),
  koi_private.chat_machine(text,jsonb) to koi_campaign_owner;

create or replace function koi_private.worker_command(p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; kind text; s koi_private.senders; c public.koi_campaigns; r public.koi_campaign_recipients; old public.koi_campaign_recipients;
 event_row record; n integer; cap integer; next_at timestamptz; boundary timestamptz; status_name text;
begin
 if p_action like 'chat\_%' escape '\' then return koi_private.chat_machine(p_action,p_data); end if;
 select b.workspace_id,b.kind into w,kind from koi_private.machine_bindings b where b.role_name=session_user;
 if w is null then raise exception 'Unbound machine' using errcode='42501'; end if;
 select * into s from koi_private.senders where workspace_id=w for update;
 if p_action='ingest' then
  if kind<>'webhook' or (p_data->>'instance') is distinct from s.instance then raise exception 'Invalid webhook' using errcode='42501'; end if;
  insert into koi_private.evolution_events(workspace_id,event_key,payload) values(w,p_data->>'eventKey',p_data) on conflict do nothing;
  -- Una baja se aplica antes del ACK, sin esperar al próximo ciclo del worker.
  if p_data->>'kind'='optout' and (p_data->>'phone') ~ '^[1-9][0-9]{9,14}$' then
   insert into public.koi_suppressions(workspace_id,phone,reason) values(w,p_data->>'phone','Baja solicitada por WhatsApp') on conflict do nothing;
   update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now() where workspace_id=w and phone=p_data->>'phone' and status in ('queued','leased');
   update koi_private.evolution_events set processed_at=now() where workspace_id=w and event_key=p_data->>'eventKey';
  end if;
  return '{"stored":true}';
 end if;
 if kind<>'worker' then raise exception 'Worker required' using errcode='42501'; end if;
 if (p_data->>'instance') is distinct from s.instance then raise exception 'Wrong instance' using errcode='42501'; end if;
 if p_action='tick' then
  update koi_private.senders set heartbeat_at=now(),worker_id=left(p_data->>'workerId',100),enabled=coalesce((p_data->>'enabled')::boolean,false) where workspace_id=w;
  -- Procesar recibos incluso con envíos deshabilitados. Eventos sin asociación permanecen pendientes.
  for event_row in select * from koi_private.evolution_events e where e.workspace_id=w and e.processed_at is null and (e.payload->>'kind'<>'receipt' or exists(select 1 from public.koi_campaign_recipients r0 where r0.workspace_id=w and r0.provider_id=e.payload->>'providerId')) order by e.id limit 100 loop
   if event_row.payload->>'kind'='receipt' then
    select * into r from public.koi_campaign_recipients where workspace_id=w and provider_id=event_row.payload->>'providerId' for update;
    if not found then continue; end if;
    status_name:=event_row.payload->>'delivery';
    if status_name not in ('sent','delivered','read','error') then continue; end if;
    if array_position(array['error','sent','delivered','read'],status_name)>coalesce(array_position(array['error','sent','delivered','read'],r.delivery),0) then
     update public.koi_campaign_recipients set delivery=status_name,updated_at=now() where id=r.id;
     insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind,details) values(w,r.campaign_id,r.id,'message.receipt',jsonb_build_object('delivery',status_name));
    end if;
   elsif event_row.payload->>'kind'='optout' then
    if (event_row.payload->>'phone') !~ '^[1-9][0-9]{9,14}$' then continue; end if;
    insert into public.koi_suppressions(workspace_id,phone,reason) values(w,event_row.payload->>'phone','Baja solicitada por WhatsApp') on conflict do nothing;
    update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now() where workspace_id=w and phone=event_row.payload->>'phone' and status in ('queued','leased');
   elsif event_row.payload->>'kind'='connection' and event_row.payload->>'state'<>'open' then
    update public.koi_campaigns set status='paused',pause_reason='disconnected',updated_at=now() where workspace_id=w and status in ('scheduled','running');
   end if;
   update koi_private.evolution_events set processed_at=now() where id=event_row.id;
  end loop;
  for old in select * from public.koi_campaign_recipients where workspace_id=w and status in ('leased','sending') and lease_until<now() for update loop
   if old.status='sending' then
    update public.koi_campaign_recipients set status='unknown',reason='interrupted',updated_at=now() where id=old.id;
    update koi_private.senders set blocked=true where workspace_id=w;
    update public.koi_campaigns set status='paused',pause_reason='unknown_result',updated_at=now() where id=old.campaign_id and status<>'cancelled';
    insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,old.campaign_id,old.id,'message.unknown');
   else
    update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=old.id;
   end if;
  end loop;
  update public.koi_campaigns c0 set status='completed',updated_at=now() where c0.workspace_id=w and c0.status in ('running','scheduled') and not exists(select 1 from public.koi_campaign_recipients r0 where r0.campaign_id=c0.id and r0.status in ('queued','leased','sending','unknown'));
  return '{"ok":true}';
 end if;
 if p_action='claim' then
  if not s.enabled or s.blocked or s.next_send_at>now() or koi_private.chat_inflight(w,s.instance) or exists(select 1 from public.koi_campaign_recipients where workspace_id=w and status in ('leased','sending','unknown')) then return null; end if;
  -- Alterna campañas elegibles. Una franja futura o un cupo menor no bloquea a la otra.
  select x.* into c from public.koi_campaigns x
  where x.workspace_id=w and x.status in ('scheduled','running')
   and koi_private.campaign_window(x.config,now())<=now()
   and exists(select 1 from public.koi_campaign_recipients q where q.campaign_id=x.id and q.status='queued' and q.next_attempt_at<=now())
   and koi_private.sender_attempts(w,s.instance,now()-interval '1 minute')<least(s.max_minute,(x.config->>'perMinute')::integer)
   and koi_private.sender_attempts(w,s.instance,now()-interval '1 hour')<least(s.max_hour,(x.config->>'perHour')::integer)
   and koi_private.sender_attempts(w,s.instance,date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman')<least(s.max_day,(x.config->>'perDay')::integer)
  order by x.last_claimed_at nulls first,x.created_at,x.id limit 1 for update;
  if not found then return null; end if;
  select * into r from public.koi_campaign_recipients where campaign_id=c.id and status='queued' and next_attempt_at<=now() order by next_attempt_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.koi_campaign_recipients set status='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where id=r.id returning * into r;
  update public.koi_campaigns set status='running',last_claimed_at=now(),updated_at=now() where id=c.id;
  return to_jsonb(r);
 end if;
 select * into r from public.koi_campaign_recipients where workspace_id=w and id=(p_data->>'id')::uuid for update;
 if not found or r.lease_token is distinct from (p_data->>'token')::uuid then return null; end if;
 select * into c from public.koi_campaigns where id=r.campaign_id for update;
 if p_action='begin' then
  if r.status<>'leased' or r.lease_until<now() then return null; end if;
  if c.status<>'running' or not s.enabled or s.blocked then update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id; return null; end if;
  if exists(select 1 from public.koi_leads where workspace_id=w and id=r.lead_id and deleted_at is not null) then
   update public.koi_campaign_recipients set status='skipped',reason='lead_deleted',lease_token=null,lease_until=null,updated_at=now() where id=r.id; return null;
  end if;
  if exists(select 1 from public.koi_suppressions where workspace_id=w and phone=r.phone) then
   update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now() where id=r.id; return null;
  end if;
  if koi_private.campaign_window(c.config,now())>now() then update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id; return null; end if;
  update public.koi_campaign_recipients set status='sending',attempt=attempt+1,lease_until=now()+interval '90 seconds',updated_at=now() where id=r.id returning * into r;
  insert into koi_private.message_attempts(recipient_id,attempt,workspace_id) values(r.id,r.attempt,w);
  update koi_private.senders set next_send_at=now()+make_interval(secs=>greatest(s.min_interval,(c.config->>'intervalSeconds')::int)) where workspace_id=w;
  insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,c.id,r.id,'message.sending');
  return to_jsonb(r);
 elsif p_action='defer' and r.status='leased' then
  update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id;
  update public.koi_campaigns set status='paused',pause_reason='provider_unavailable',updated_at=now() where id=c.id and status in ('running','scheduled');
 elsif p_action='finish' and r.status in ('sending','unknown') then
  status_name:=p_data->>'outcome';
  if status_name not in ('accepted','failed','unknown') or (status_name='accepted' and coalesce(length(p_data->>'providerId'),0) not between 1 and 200) then raise exception 'Invalid outcome' using errcode='22023'; end if;
  update public.koi_campaign_recipients set status=status_name,provider_id=case when status_name='accepted' then p_data->>'providerId' end,reason=left(p_data->>'reason',100),updated_at=now() where id=r.id;
  update koi_private.message_attempts set finished_at=now(),outcome=status_name,provider_id=p_data->>'providerId' where recipient_id=r.id and attempt=r.attempt;
  if status_name='failed' and p_data->>'reason' in ('provider_401','provider_403','provider_404') then update public.koi_campaigns set status='paused',pause_reason='provider_unavailable' where id=c.id and status<>'cancelled'; end if;
  if status_name='unknown' then
   update koi_private.senders set blocked=true where workspace_id=w;
   update public.koi_campaigns set status='paused',pause_reason='unknown_result',updated_at=now() where id=c.id and status<>'cancelled';
  else
   update koi_private.senders set blocked=exists(select 1 from public.koi_campaign_recipients where workspace_id=w and status='unknown') where workspace_id=w;
  end if;
  insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,c.id,r.id,'message.'||status_name);
 else return null;
 end if;
 return '{"ok":true}';
end $$;

commit;
