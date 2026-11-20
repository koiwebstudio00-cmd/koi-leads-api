begin;
alter table koi_private.inbox_reads add column through_seq bigint not null default 0;
alter table koi_private.inbox_reads add column marked_unread boolean not null default false;
alter table koi_private.inbox_reads add column revision integer not null default 0;
update koi_private.inbox_reads r set through_seq=m.seq from koi_private.inbox_messages m where m.id=r.through_message_id;
create index inbox_live_unread on koi_private.inbox_messages(workspace_id,conversation_id,seq) where direction='in' and not historical;
create index inbox_summary_scan on public.koi_inbox_conversations(workspace_id,id);

create function koi_private.inbox_message_view(m koi_private.inbox_messages,preview boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',m.id,'seq',m.seq,'direction',m.direction,'body',case when preview then left(m.body,300) else m.body end,
 'sent_at',m.sent_at,'status',m.status,'delivery',m.delivery,'historical',m.historical,
 'attachment_mime',coalesce(m.provider_attachments->0->>'mimeType',case m.provider_attachments->0->>'type' when 'image' then 'image/jpeg' when 'video' then 'video/mp4' when 'audio' then 'audio/mpeg' when 'sticker' then 'image/webp' else case when jsonb_array_length(m.provider_attachments)>0 then 'application/octet-stream' end end),
 'attachment_name',coalesce(m.provider_attachments->0->>'filename','Adjunto'),
 'attachments',coalesce((select jsonb_agg(jsonb_build_object('index',pos-1,'type',value->>'type','originalType',value->>'originalType','mimeType',value->>'mimeType','filename',value->>'filename') order by pos)
  from jsonb_array_elements(m.provider_attachments) with ordinality a(value,pos)),'[]'))
$$;
revoke all on function koi_private.inbox_message_view(koi_private.inbox_messages,boolean) from public,anon,authenticated;

create function koi_private.inbox_row(c public.koi_inbox_conversations,actor uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',c.id,'accountId',c.account_id,'channel',c.channel,'leadId',c.lead_id,
 'name',coalesce(nullif(l.name,''),nullif(i.display_name,''),i.username,l.phone,'Contacto'),
 'phone',l.phone,'username',i.username,'company',l.company,'product',l.product,'stage',l.stage,
 'assignedTo',l.assigned_to,'archived',c.archived,'accountLabel',a.label,'accountAddress',a.address,'accountState',a.state,
 'updatedAt',c.updated_at,'lastMessageAt',coalesce(m.sent_at,c.created_at),'lastMessage',case when m.id is not null then koi_private.inbox_message_view(m,true) end,
 'unread',greatest(case when coalesce(r.marked_unread,false) then 1 else 0 end,
  (select count(*) from koi_private.inbox_messages u where u.workspace_id=c.workspace_id and u.conversation_id=c.id and u.direction='in' and not u.historical and u.sent_at<=now() and u.seq>coalesce(r.through_seq,0))),
 'readRevision',coalesce(r.revision,0),
 'pendingReply',coalesce(c.last_live_inbound_at>coalesce(c.last_outbound_at,'-infinity'),false),
 'replyWindow',koi_private.inbox_reply_window(c.last_inbound_at,now(),a.state))
 from public.koi_leads l join koi_private.inbox_identities i on i.id=c.identity_id
 join public.koi_inbox_accounts a on a.id=c.account_id
 left join koi_private.inbox_reads r on r.conversation_id=c.id and r.user_id=actor
 left join lateral (select * from koi_private.inbox_messages where workspace_id=c.workspace_id and conversation_id=c.id order by sent_at desc,id desc limit 1) m on true
 where l.id=c.lead_id and l.workspace_id=c.workspace_id and l.deleted_at is null
$$;
revoke all on function koi_private.inbox_row(public.koi_inbox_conversations,uuid) from public,anon,authenticated;

create function public.koi_inbox_query(action text,data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; c public.koi_inbox_conversations; anchor koi_private.inbox_messages;
 rows jsonb; result jsonb; cursor_id uuid; requested uuid[]; count_members integer; changed integer;
 page_limit integer:=coalesce((data->>'limit')::int,50); target uuid; revision_value integer;
begin
 select count(*),min(workspace_id::text)::uuid into count_members,w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or count_members<>1 then raise exception 'Membership required' using errcode='42501'; end if;
 if action='accounts' then
   select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'address',address,'channel',channel,'state',state) order by created_at,id),'[]') into result from public.koi_inbox_accounts where workspace_id=w;
   return result;
 elsif action='unread_count' then
   return jsonb_build_object('count',(select count(*) from public.koi_inbox_conversations x join public.koi_leads l on l.id=x.lead_id
    left join koi_private.inbox_reads r on r.conversation_id=x.id and r.user_id=actor
    where x.workspace_id=w and not x.archived and l.deleted_at is null and (coalesce(r.marked_unread,false) or exists(
    select 1 from koi_private.inbox_messages m where m.workspace_id=w and m.conversation_id=x.id and m.direction='in' and not m.historical and m.sent_at<=now() and m.seq>coalesce(r.through_seq,0)))));
 elsif action='index' then
   cursor_id:=(data->>'after')::uuid;
   if data?'ids' then
     if jsonb_typeof(data->'ids')<>'array' or jsonb_array_length(data->'ids') not between 1 and 100 or cursor_id is not null then raise exception 'Invalid ids' using errcode='22023'; end if;
     select array_agg(value::uuid) into requested from jsonb_array_elements_text(data->'ids');
   end if;
   with candidates as materialized (
    select x.* from public.koi_inbox_conversations x join public.koi_leads l on l.id=x.lead_id
    where x.workspace_id=w and l.deleted_at is null and (cursor_id is null or x.id>cursor_id) and (requested is null or x.id=any(requested)) order by x.id limit 201
   ), page as materialized (select id,koi_private.inbox_row(x::public.koi_inbox_conversations,actor) item from (select * from candidates order by id limit 200) x)
   select coalesce(jsonb_agg(item order by id),'[]'),case when (select count(*) from candidates)>200 then (select id from page order by id desc limit 1) end into rows,cursor_id from page;
   return jsonb_build_object('userId',actor,'rows',rows,'nextCursor',cursor_id);
 end if;
 select x.* into c from public.koi_inbox_conversations x join public.koi_leads l on l.id=x.lead_id
 where x.id=(data->>'id')::uuid and x.workspace_id=w and l.deleted_at is null;
 if c.id is null then raise exception 'Conversation not found' using errcode='PT404'; end if;
 if action='messages' then
   if page_limit not between 1 and 100 then raise exception 'Invalid limit' using errcode='22023'; end if;
   if data->>'before' is not null then
     select * into anchor from koi_private.inbox_messages where workspace_id=w and conversation_id=c.id and id=(data->>'before')::uuid;
     if anchor.id is null then raise exception 'Cursor not found' using errcode='PT404'; end if;
   end if;
   with candidates as materialized (select * from koi_private.inbox_messages m where m.workspace_id=w and m.conversation_id=c.id
    and (anchor.id is null or (m.sent_at,m.id)<(anchor.sent_at,anchor.id)) order by m.sent_at desc,m.id desc limit page_limit+1),
   page as materialized (select * from candidates order by sent_at desc,id desc limit page_limit)
   select coalesce(jsonb_agg(koi_private.inbox_message_view(page::koi_private.inbox_messages) order by sent_at,id),'[]'),
    case when (select count(*) from candidates)>page_limit then (select id from page order by sent_at,id limit 1) end into rows,cursor_id from page;
   return jsonb_build_object('conversation',koi_private.inbox_row(c,actor),'messages',rows,'nextCursor',cursor_id);
 elsif action='media_lookup' then
   select * into anchor from koi_private.inbox_messages where workspace_id=w and conversation_id=c.id and id=(data->>'messageId')::uuid;
   if anchor.id is null or anchor.external_id is null or (data->>'index')::int is null or (data->>'index')::int<0 or (data->>'index')::int>=jsonb_array_length(anchor.provider_attachments) then raise exception 'Attachment not found' using errcode='PT404'; end if;
   return jsonb_build_object('accountId',(select external_id from public.koi_inbox_accounts where id=c.account_id),
    'conversationId',c.external_id,'messageId',anchor.external_id,'index',(data->>'index')::int,'name',coalesce(anchor.provider_attachments->((data->>'index')::int)->>'filename','Adjunto'));
 elsif action='archive' then
   if jsonb_typeof(data->'archived') is distinct from 'boolean' then raise exception 'Invalid archive' using errcode='22023'; end if;
   update public.koi_inbox_conversations set archived=(data->>'archived')::boolean,updated_at=now() where id=c.id and archived is distinct from (data->>'archived')::boolean;
 elsif action='assign' then
   target:=(data->>'assignedTo')::uuid;
   if not (data?'assignedTo') or (target is not null and not exists(select 1 from public.koi_workspace_members where workspace_id=w and user_id=target)) then raise exception 'Invalid assignee' using errcode='42501'; end if;
   update public.koi_leads set assigned_to=target where workspace_id=w and id=c.lead_id and assigned_to is distinct from target;
 elsif action='read' then
   revision_value:=(data->>'revision')::int;
   if revision_value is null or revision_value<0 then raise exception 'Invalid revision' using errcode='22023'; end if;
   select * into anchor from koi_private.inbox_messages where workspace_id=w and conversation_id=c.id and id=(data->>'throughMessageId')::uuid;
   if anchor.id is null then raise exception 'Read cursor not found' using errcode='PT404'; end if;
   if revision_value=0 then
     insert into koi_private.inbox_reads(workspace_id,conversation_id,user_id) values(w,c.id,actor) on conflict do nothing;
   end if;
   update koi_private.inbox_reads set through_seq=greatest(through_seq,anchor.seq),through_message_id=case when anchor.seq>=through_seq then anchor.id else through_message_id end,
    marked_unread=false,revision=revision+1,updated_at=now()
    where conversation_id=c.id and user_id=actor and revision=revision_value and (through_seq<anchor.seq or marked_unread);
   get diagnostics changed=row_count;
   if changed>0 then update public.koi_inbox_conversations set updated_at=now() where id=c.id; end if;
 elsif action='unread' then
   insert into koi_private.inbox_reads(workspace_id,conversation_id,user_id,marked_unread,revision) values(w,c.id,actor,true,1)
   on conflict(workspace_id,conversation_id,user_id) do update set marked_unread=true,revision=koi_private.inbox_reads.revision+1,updated_at=now();
   update public.koi_inbox_conversations set updated_at=now() where id=c.id;
 else raise exception 'Unknown action' using errcode='22023';
 end if;
 select * into c from public.koi_inbox_conversations where id=c.id;
 return koi_private.inbox_row(c,actor);
end $$;
revoke all on function public.koi_inbox_query(text,jsonb) from public,anon,authenticated;
grant execute on function public.koi_inbox_query(text,jsonb) to authenticated;

create function koi_private.inbox_lead_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.koi_inbox_conversations set assigned_to=new.assigned_to,updated_at=now() where workspace_id=new.workspace_id and lead_id=new.id;
 return new;
end $$;
revoke all on function koi_private.inbox_lead_changed() from public,anon,authenticated;
create trigger koi_inbox_lead_changed after update of name,phone,company,product,stage,assigned_to,deleted_at on public.koi_leads for each row execute function koi_private.inbox_lead_changed();
create function koi_private.inbox_message_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.koi_inbox_conversations set updated_at=now() where workspace_id=new.workspace_id and id=new.conversation_id;
 return new;
end $$;
revoke all on function koi_private.inbox_message_changed() from public,anon,authenticated;
create trigger koi_inbox_message_changed after insert or update on koi_private.inbox_messages for each row execute function koi_private.inbox_message_changed();
do $$ begin
 if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
   alter publication supabase_realtime add table public.koi_inbox_accounts,public.koi_inbox_conversations;
 end if;
end $$;
commit;
