begin;

-- Keep provider click identifiers and raw attribution metadata private.
create function koi_private.chat_author_name(actor uuid) returns text
language sql stable strict security invoker set search_path='' as $$
  select coalesce(nullif(btrim(to_jsonb(u)#>>'{raw_user_meta_data,full_name}'),''),
                  nullif(btrim(to_jsonb(u)#>>'{raw_user_meta_data,name}'),''),
                  nullif(split_part(to_jsonb(u)->>'email','@',1),''))
  from auth.users u where u.id=actor
$$;
revoke all on function koi_private.chat_author_name(uuid) from public,anon,authenticated;

alter table koi_private.inbox_outbox add column followup_template jsonb;

-- This entry point is available only to the bound API gateway after it has
-- resolved the approved template and rendered its parameters for this account.
create function koi_private.inbox_followup_template(action text, p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  b koi_private.inbox_bindings;
  c public.koi_inbox_conversations;
  a public.koi_inbox_accounts;
  m koi_private.inbox_messages;
  job koi_private.inbox_outbox;
  actor uuid := (p->>'actorId')::uuid;
  key uuid := (p->>'requestId')::uuid;
  fingerprint text;
begin
  select * into b from koi_private.inbox_bindings where role_name=session_user and kind='gateway';
  if b.role_name is null or not pg_has_role(session_user,'koi_inbox_gateway','member')
     or not exists(select from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin')
     or not exists(select from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=actor and role in ('admin','operator'))
  then raise exception 'Membership required' using errcode='42501'; end if;

  select x.* into c from public.koi_inbox_conversations x
  join public.koi_leads l on l.id=x.lead_id and l.workspace_id=x.workspace_id
  where x.id=(p->>'id')::uuid and x.workspace_id=b.workspace_id and x.channel='whatsapp' and l.deleted_at is null
  for update of x;
  if c.id is null then raise exception 'Conversation unavailable' using errcode='PT404'; end if;
  select * into strict a from public.koi_inbox_accounts where id=c.account_id and workspace_id=b.workspace_id;
  if a.state<>'connected' then raise exception 'Disconnected' using errcode='PT422'; end if;
  if exists(select from public.koi_suppressions s join public.koi_leads l on l.workspace_id=s.workspace_id and l.phone=s.phone
    where l.id=c.lead_id) then raise exception 'Contact opted out' using errcode='PT403'; end if;
  if action='lookup' then return jsonb_build_object('accountId',a.external_id); end if;
  if action is distinct from 'enqueue' or a.external_id is distinct from p->>'accountId' or key is null
    or jsonb_typeof(p->'template') is distinct from 'object' or nullif(p#>>'{template,name}','') is null
    or nullif(p#>>'{template,language}','') is null or coalesce(length(p->>'text'),0) not between 1 and 10000
  then raise exception 'Invalid template' using errcode='22023'; end if;

  fingerprint:=encode(sha256(convert_to(jsonb_build_array('template',c.id,p->'template')::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor::text||key::text,918));
  select * into job from koi_private.inbox_outbox where workspace_id=b.workspace_id and actor_id=actor and request_id=key;
  if job.id is not null then
    if job.request_hash<>fingerprint then raise exception 'Idempotency conflict' using errcode='PT409'; end if;
    select * into strict m from koi_private.inbox_messages where id=job.message_id;
    return koi_private.inbox_message_view(m);
  end if;
  if exists(select from koi_private.inbox_outbox where conversation_id=c.id and status='unknown')
    then raise exception 'Review uncertain send' using errcode='PT423'; end if;

  insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,direction,body,sent_at,actor_id,status)
    values(b.workspace_id,a.id,c.id,'out',p->>'text',clock_timestamp(),actor,'queued') returning * into m;
  insert into koi_private.inbox_outbox(workspace_id,account_id,conversation_id,message_id,actor_id,request_id,request_hash,followup_template)
    values(b.workspace_id,a.id,c.id,m.id,actor,key,fingerprint,p->'template');
  update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
  return koi_private.inbox_message_view(m);
end $$;
revoke all on function koi_private.inbox_followup_template(text,jsonb) from public,anon,authenticated,koi_inbox_ingest;
grant execute on function koi_private.inbox_followup_template(text,jsonb) to koi_inbox_gateway;

create or replace function koi_private.inbox_row(c public.koi_inbox_conversations,actor uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',c.id,'accountId',c.account_id,'channel',c.channel,'leadId',c.lead_id,
 'name',coalesce(nullif(l.name,''),nullif(i.display_name,''),i.username,l.phone,'Contacto'),
 'adOrigin',case when touch.conversation_id is not null then
   jsonb_build_object('name',touch.ad_name,'id',touch.ad_id,'campaign',touch.campaign_name) end,
 'phone',l.phone,'username',i.username,'company',l.company,'product',l.product,'stage',l.stage,
 'assignedTo',l.assigned_to,'archived',c.archived,'accountLabel',a.label,'accountAddress',a.address,'accountState',a.state,
 'updatedAt',c.updated_at,'lastMessageAt',coalesce(m.sent_at,c.created_at),'lastMessage',case when m.id is not null then koi_private.inbox_message_view(m,true) end,
 'unread',greatest(case when coalesce(r.marked_unread,false) then 1 else 0 end,
  (select count(*) from koi_private.inbox_messages u where u.workspace_id=c.workspace_id and u.conversation_id=c.id and u.direction='in' and not u.historical and u.sent_at<=now() and u.seq>coalesce(r.through_seq,0))),
 'readRevision',coalesce(r.revision,0),
 'pendingReply',coalesce(c.last_live_inbound_at>coalesce(c.last_outbound_at,'-infinity'),false),
 'replyWindow',koi_private.inbox_effective_window(c,a,now(),true))
 from public.koi_leads l join koi_private.inbox_identities i on i.id=c.identity_id
 join public.koi_inbox_accounts a on a.id=c.account_id
 left join koi_private.stats_first_touch touch on touch.conversation_id=c.id and touch.workspace_id=c.workspace_id
 left join koi_private.inbox_reads r on r.conversation_id=c.id and r.user_id=actor
 left join lateral (select * from koi_private.inbox_messages where workspace_id=c.workspace_id and conversation_id=c.id order by sent_at desc,id desc limit 1) m on true
 where l.id=c.lead_id and l.workspace_id=c.workspace_id and l.deleted_at is null
$$;
create or replace function koi_private.chat_message_json(message koi_private.chat_messages) returns jsonb
language sql stable set search_path='' as $$
  select (to_jsonb(message) - array['workspace_id','instance','lease_token','lease_until','request_id','request_hash','retry_at','attempted_at','provider_id','quote_provider_id','quote_text'])
    || jsonb_build_object(
      'authorName',koi_private.chat_author_name(message.actor_id),'clientKey',message.request_id,
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
create or replace function koi_private.inbox_message_view(m koi_private.inbox_messages,preview boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$
 select koi_private.inbox_message_view_pre_interactions(m,preview)
   || case when preview or m.actor_id is null then '{}'::jsonb else jsonb_build_object('authorName',koi_private.chat_author_name(m.actor_id)) end
   || case when preview then '{}'::jsonb else koi_private.inbox_message_interactions(m) end
   || case when m.native_sticker is null then '{}'::jsonb else jsonb_build_object('nativeSticker',m.native_sticker) end
$$;
create or replace function koi_private.inbox_dispatch(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b koi_private.inbox_bindings; o koi_private.inbox_outbox; c public.koi_inbox_conversations;
 a public.koi_inbox_accounts; m koi_private.inbox_messages; duplicate koi_private.inbox_messages;
 expiry jsonb; outcome text; why text; result jsonb; ext text;
begin
 select * into b from koi_private.inbox_bindings where role_name=session_user and kind='ingest';
 if b.role_name is null or not pg_has_role(session_user,'koi_inbox_ingest','member') or not exists(
 select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin') then raise exception 'Unbound worker' using errcode='42501'; end if;
 if action is null or action not in ('claim','begin','finish','defer','prepare_media') then raise exception 'Invalid dispatch action' using errcode='22023'; end if;
 -- Short transaction lock only. Provider calls happen outside transactions and may run concurrently.
 perform pg_advisory_xact_lock(hashtextextended(b.workspace_id::text,919));
 if action='claim' then
   for o in select * from koi_private.inbox_outbox where workspace_id=b.workspace_id and status in ('leased','sending') and lease_until<clock_timestamp() for update loop
     outcome:=case when o.status='sending' then 'unknown' else 'queued' end;
     update koi_private.inbox_outbox set status=outcome,reason=case when outcome='unknown' then 'interrupted_send' end,lease_token=null,lease_until=null where id=o.id;
     update koi_private.inbox_messages set status=outcome where id=o.message_id;
     update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=o.conversation_id;
   end loop;
   select x.* into o from koi_private.inbox_outbox x where x.workspace_id=b.workspace_id and x.status='queued' and x.retry_at<=clock_timestamp()
   and not exists(select 1 from koi_private.inbox_outbox prior where prior.conversation_id=x.conversation_id and prior.status in ('queued','leased','sending','unknown') and (prior.created_at,prior.id)<(x.created_at,x.id))
   and not exists(select 1 from koi_private.inbox_outbox active where active.conversation_id=x.conversation_id and active.status in ('leased','sending','unknown'))
   order by x.created_at,x.id for update skip locked limit 1;
   if o.id is null then return null; end if;
   update koi_private.inbox_outbox set status='leased',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' where id=o.id returning * into o;
   select * into c from public.koi_inbox_conversations where id=o.conversation_id;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   return jsonb_build_object('hasAttachment',exists(select 1 from koi_private.inbox_sent_files where job_id=o.id),
     'richContent',exists(select 1 from koi_private.inbox_messages where id=o.message_id and (native_sticker is not null or quoted_external_id is not null)),
     'id',o.id,'lease',o.lease_token,'accountId',a.external_id,'conversationId',c.external_id,
     'channel',c.channel,'profileId',b.profile_id,'workspaceId',b.workspace_id);
 end if;
 -- Same lock order as ingestion: conversation before message/outbox mutation.
 select x.* into c from public.koi_inbox_conversations x join koi_private.inbox_outbox job on job.conversation_id=x.id where job.id=(p->>'id')::uuid and job.workspace_id=b.workspace_id for update of x;
 select * into o from koi_private.inbox_outbox where id=(p->>'id')::uuid and workspace_id=b.workspace_id for update;
 if o.id is null or o.lease_token is distinct from (p->>'lease')::uuid or o.lease_token is null or o.lease_until<clock_timestamp() then return null; end if;
 if action='prepare_media' then
   if o.status<>'leased' then return null; end if;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   if not (koi_private.inbox_effective_window(c,a,clock_timestamp(),false)->>'canReply')::boolean
     or not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=o.actor_id and role in ('admin','operator'))
     or exists(select 1 from public.koi_leads where id=c.lead_id and deleted_at is not null) then
     -- Let begin retire the invalid work without processing a file.
     perform koi_private.inbox_dispatch('begin',p);
     return null;
   end if;
   -- Conversion and upload run while leased. Only begin can move this job to sending.
   update koi_private.inbox_outbox set lease_until=clock_timestamp()+interval '60 seconds' where id=o.id;
   return (select koi_private.inbox_file_json(f) from koi_private.inbox_sent_files f where f.job_id=o.id);
 end if;
 if action='begin' then
   if o.status<>'leased' then return null; end if;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   select * into m from koi_private.inbox_messages where id=o.message_id;
   expiry:=koi_private.inbox_effective_window(c,a,clock_timestamp(),m.native_sticker is null and not exists(select 1 from koi_private.inbox_sent_files where job_id=o.id));
   why:=case when o.followup_template is not null and (a.state<>'connected' or c.channel<>'whatsapp') then 'account_disconnected'
     when o.followup_template is not null and exists(select from public.koi_suppressions s join public.koi_leads l
       on l.workspace_id=s.workspace_id and l.phone=s.phone where l.id=c.lead_id) then 'contact_suppressed'
     when o.followup_template is null and not (expiry->>'canReply')::boolean then expiry->>'reason'
     when not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=o.actor_id and role in ('admin','operator')) then 'member_removed'
     when exists(select 1 from public.koi_leads where id=c.lead_id and deleted_at is not null) then 'contact_deleted' end;
   if why is not null then
     update koi_private.inbox_outbox set status='failed',reason=why,lease_token=null,lease_until=null where id=o.id;
     update koi_private.inbox_messages set status='failed' where id=o.message_id;
     update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;return null;
   end if;
   update koi_private.inbox_outbox set status='sending',attempts=attempts+1,dispatched_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds' where id=o.id;
   update koi_private.inbox_messages set status='sending' where id=o.message_id returning * into m;
   update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
   if o.followup_template is not null then
     return jsonb_build_object('requestId',o.id,'template',o.followup_template);
   end if;
   return jsonb_build_object('text',m.body,'requestId',o.id,'expiresAt',expiry->>'expiresAt','replyTo',m.quoted_external_id,'humanAgent',expiry->>'mode'='human_agent','sticker',m.native_sticker);
 elsif action='defer' then
   if o.status<>'leased' then return null; end if;
   outcome:=case when p->>'terminal'='true' then 'failed' else 'queued' end;
 elsif action='finish' then
   if o.status<>'sending' then return null; end if;
   outcome:=p->>'outcome';
   if outcome not in ('accepted','failed','unknown','queued') or outcome is null then raise exception 'Invalid outcome' using errcode='22023'; end if;
   if outcome='queued' and o.attempts>=5 then outcome:='failed'; end if;
   if outcome='accepted' then
     ext:=p->>'externalId';
     if ext is null or char_length(ext) not between 1 and 200 then raise exception 'Missing message identity' using errcode='22023'; end if;
     select * into duplicate from koi_private.inbox_messages where workspace_id=b.workspace_id and account_id=o.account_id and external_id=ext;
     if duplicate.id is not null and duplicate.id<>o.message_id then
       if duplicate.conversation_id<>c.id or duplicate.direction<>'out' or exists(select 1 from koi_private.inbox_outbox where message_id=duplicate.id) then raise exception 'Message identity conflict' using errcode='22023'; end if;
       -- A webhook/history page can arrive before the POST response. Preserve the local id.
       update koi_private.inbox_reads set through_message_id=o.message_id where through_message_id=duplicate.id;
       delete from koi_private.inbox_messages where id=duplicate.id;
     end if;
     update koi_private.inbox_messages set external_id=ext,status='accepted',sent_at=coalesce(duplicate.sent_at,o.dispatched_at),
       quoted_external_id=coalesce(quoted_external_id,duplicate.quoted_external_id),delivery=coalesce(duplicate.delivery,'sent'),historical=false where id=o.message_id;
     update public.koi_inbox_conversations set last_outbound_at=case when duplicate.delivery='error' then last_outbound_at else greatest(last_outbound_at,coalesce(duplicate.sent_at,o.dispatched_at)) end where id=c.id;
   end if;
 end if;
 update koi_private.inbox_outbox set status=outcome,reason=case when outcome='accepted' then null else left(p->>'reason',100) end,
 lease_token=null,lease_until=null,retry_at=clock_timestamp()+make_interval(secs=>least(3600,greatest(5,coalesce((p->>'retryAfter')::int,30)))) where id=o.id;
 if outcome<>'accepted' then update koi_private.inbox_messages set status=outcome where id=o.message_id; end if;
 if outcome='unknown' then
   -- Refresh provider evidence, but never match sends by text or assume an empty history proves failure.
   insert into koi_private.inbox_sync_jobs(workspace_id,account_id) values(b.workspace_id,o.account_id)
   on conflict(account_id,conversation_key) do update set retry_at=least(koi_private.inbox_sync_jobs.retry_at,clock_timestamp());
 end if;
 update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
 return jsonb_build_object('status',outcome);
end $$;
commit;
