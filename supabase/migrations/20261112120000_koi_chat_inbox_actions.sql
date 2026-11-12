-- Bandejas por número, borradores sin chats vacíos, marcar como no leído y eliminar chat (borrado lógico).
alter table public.koi_conversations add column if not exists deleted_at timestamptz;
create index if not exists koi_conversation_live on public.koi_conversations(workspace_id, archived, updated_at desc, id) where deleted_at is null;

-- Un chat borrado vuelve a la bandeja cuando hay actividad nueva (mensaje entrante o saliente).
create or replace function koi_private.conversation_reopen() returns trigger language plpgsql set search_path='' as $$
begin
  if old.deleted_at is not null and new.deleted_at is not null and new.updated_at is distinct from old.updated_at then
    new.deleted_at:=null;
  end if;
  return new;
end $$;
revoke all on function koi_private.conversation_reopen() from public,anon,authenticated;
drop trigger if exists conversation_reopen on public.koi_conversations;
create trigger conversation_reopen before update on public.koi_conversations for each row execute function koi_private.conversation_reopen();

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
      where x.workspace_id=w and x.deleted_at is null and exists(select 1 from koi_private.chat_messages any_msg where any_msg.conversation_id=x.id)
      and x.archived=coalesce((data->>'archived')::boolean,false)
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
    select * into c from public.koi_conversations where workspace_id=w and instance=instance_name and peer=l.phone||'@s.whatsapp.net';
    if not found then raise exception 'Chat not started' using errcode='PT404'; end if;
    update public.koi_conversations set deleted_at=null where id=c.id returning * into c;
    return koi_private.chat_row(c,actor);
  end if;
  if action='by_lead' then
    select * into l from public.koi_leads where id=(data->>'leadId')::uuid and workspace_id=w and deleted_at is null;
    if l.id is null then raise exception 'Lead missing' using errcode='PT404'; end if;
    return coalesce((select jsonb_agg(q.item order by q.updated_at desc,q.id) from (
      select x.id,x.updated_at,koi_private.chat_row(x,actor) item from public.koi_conversations x
      where x.workspace_id=w and x.lead_id=l.id and x.deleted_at is null
      and exists(select 1 from koi_private.chat_messages any_msg where any_msg.conversation_id=x.id)
    ) q),'[]');
  end if;
  if action='send_new' then
    select i.instance into instance_name from koi_private.chat_instances(w) i where i.id=data->>'instanceId';
    select * into l from public.koi_leads where id=(data->>'leadId')::uuid and workspace_id=w and deleted_at is null;
    if instance_name is null or l.id is null then raise exception 'Lead or instance missing' using errcode='PT404'; end if;
    -- La fila se crea recién al enviar: abrir un borrador no deja chats vacíos en la bandeja.
    insert into public.koi_conversations(workspace_id,instance,peer,phone,name,lead_id,assigned_to)
    values(w,instance_name,l.phone||'@s.whatsapp.net',l.phone,l.name,l.id,l.assigned_to)
    on conflict(workspace_id,instance,peer) do update set lead_id=excluded.lead_id,archived=false,deleted_at=null returning * into c;
    action:='send';
    data:=data||jsonb_build_object('id',c.id);
  end if;
  select * into c from public.koi_conversations where id=(data->>'id')::uuid and workspace_id=w;
  if not found then raise exception 'Chat not found' using errcode='PT404'; end if;
  if action='unread' then
    insert into koi_private.chat_reads(conversation_id,user_id,last_seq)
    select c.id,actor,greatest(0,coalesce(max(seq),0)-1) from koi_private.chat_messages
    where conversation_id=c.id and direction='in' and not historical
    on conflict(conversation_id,user_id) do update set last_seq=excluded.last_seq;
    return '{"ok":true}';
  end if;
  if action='delete' then
    update public.koi_conversations set deleted_at=now() where id=c.id;
    return '{"ok":true}';
  end if;

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
