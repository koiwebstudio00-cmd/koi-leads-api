begin;
alter table koi_private.inbox_outbox add column dispatched_at timestamptz;
create index inbox_outbox_order on koi_private.inbox_outbox(workspace_id,conversation_id,created_at,id) where status in ('queued','leased','sending','unknown');

-- Keep the existing view contract and add correlation/error information for Inbox only.
do $migration$
declare definition text;
begin
 select pg_get_functiondef('koi_private.inbox_message_view(koi_private.inbox_messages,boolean)'::regprocedure) into definition;
 if position('''seq'',m.seq' in definition)=0 then raise exception 'Unexpected message view'; end if;
 definition:=replace(definition,'''seq'',m.seq',
 '''seq'',m.seq,''externalId'',m.external_id,''clientKey'',(select request_id from koi_private.inbox_outbox where message_id=m.id),''sendReason'',(select reason from koi_private.inbox_outbox where message_id=m.id)');
 execute definition;
end $migration$;

create function public.koi_inbox_send(action text,data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; members integer; c public.koi_inbox_conversations;
 a public.koi_inbox_accounts; o koi_private.inbox_outbox; m koi_private.inbox_messages; body text; key uuid; fingerprint text;
begin
 select count(*),min(workspace_id::text)::uuid into members,w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or members<>1 then raise exception 'Membership required' using errcode='42501'; end if;
 if action not in ('send','resolve_send') then raise exception 'Invalid action' using errcode='22023'; end if;
 select x.* into c from public.koi_inbox_conversations x join public.koi_leads l on l.id=x.lead_id
 where x.id=(data->>'id')::uuid and x.workspace_id=w and l.deleted_at is null for update of x;
 if c.id is null then raise exception 'Conversation not found' using errcode='PT404'; end if;
 if action='resolve_send' then
   select * into o from koi_private.inbox_outbox where workspace_id=w and conversation_id=c.id and message_id=(data->>'messageId')::uuid for update;
   if o.id is null then raise exception 'Message not found' using errcode='PT404'; end if;
   if o.status<>'unknown' then raise exception 'Message changed' using errcode='PT409'; end if;
   update koi_private.inbox_outbox set status='closed',reason='reviewed',lease_token=null,lease_until=null where id=o.id;
   update koi_private.inbox_messages set status='closed' where id=o.message_id returning * into m;
 else
   body:=btrim(data->>'text'); key:=(data->>'requestId')::uuid;
   if key is null or body is null or char_length(body) not between 1 and 10000 or (data-'id'-'text'-'requestId')<>'{}' then raise exception 'Invalid text request' using errcode='22023'; end if;
   fingerprint:=encode(sha256(convert_to(jsonb_build_array(c.id,body)::text,'UTF8')),'hex');
   -- A request key is durable, scoped to its author, and cannot be repurposed.
   perform pg_advisory_xact_lock(hashtextextended(actor::text||key::text,918));
   select * into o from koi_private.inbox_outbox where workspace_id=w and actor_id=actor and request_id=key;
   if o.id is not null then
     if o.request_hash<>fingerprint then raise exception 'Idempotency conflict' using errcode='PT409'; end if;
     select * into m from koi_private.inbox_messages where id=o.message_id;
     return koi_private.inbox_message_view(m);
   end if;
   select * into a from public.koi_inbox_accounts where id=c.account_id;
   if not (koi_private.inbox_reply_window(c.last_inbound_at,clock_timestamp(),a.state)->>'canReply')::boolean then raise exception 'Reply window closed' using errcode='PT422'; end if;
   if exists(select 1 from koi_private.inbox_outbox where conversation_id=c.id and status='unknown') then raise exception 'Review uncertain send' using errcode='PT423'; end if;
   insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,direction,body,sent_at,actor_id,status)
   values(w,c.account_id,c.id,'out',body,clock_timestamp(),actor,'queued') returning * into m;
   insert into koi_private.inbox_outbox(workspace_id,account_id,conversation_id,message_id,actor_id,request_id,request_hash)
   values(w,c.account_id,c.id,m.id,actor,key,fingerprint);
 end if;
 update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
 return koi_private.inbox_message_view(m);
end $$;
revoke all on function public.koi_inbox_send(text,jsonb) from public,anon,authenticated;
grant execute on function public.koi_inbox_send(text,jsonb) to authenticated;

-- The existing Inbox worker has a second bounded loop, with the same scoped login.
create function koi_private.inbox_dispatch(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b koi_private.inbox_bindings; o koi_private.inbox_outbox; c public.koi_inbox_conversations;
 a public.koi_inbox_accounts; m koi_private.inbox_messages; duplicate koi_private.inbox_messages;
 expiry jsonb; outcome text; why text; result jsonb; ext text;
begin
 select * into b from koi_private.inbox_bindings where role_name=session_user and kind='ingest';
 if b.role_name is null or not pg_has_role(session_user,'koi_inbox_ingest','member') or not exists(
 select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin') then raise exception 'Unbound worker' using errcode='42501'; end if;
 if action not in ('claim','begin','finish','defer') then raise exception 'Invalid dispatch action' using errcode='22023'; end if;
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
   return jsonb_build_object('id',o.id,'lease',o.lease_token,'accountId',a.external_id,'conversationId',c.external_id,'channel',c.channel,'profileId',b.profile_id,'workspaceId',b.workspace_id);
 end if;
 -- Same lock order as ingestion: conversation before message/outbox mutation.
 select x.* into c from public.koi_inbox_conversations x join koi_private.inbox_outbox job on job.conversation_id=x.id where job.id=(p->>'id')::uuid and job.workspace_id=b.workspace_id for update of x;
 select * into o from koi_private.inbox_outbox where id=(p->>'id')::uuid and workspace_id=b.workspace_id for update;
 if o.id is null or o.lease_token is distinct from (p->>'lease')::uuid or o.lease_token is null or o.lease_until<clock_timestamp() then return null; end if;
 if action='begin' then
   if o.status<>'leased' then return null; end if;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   expiry:=koi_private.inbox_reply_window(c.last_inbound_at,clock_timestamp(),a.state);
   why:=case when not (expiry->>'canReply')::boolean then expiry->>'reason'
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
   return jsonb_build_object('text',m.body,'requestId',o.id,'expiresAt',expiry->>'expiresAt');
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
       delivery=coalesce(duplicate.delivery,'sent'),historical=false where id=o.message_id;
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
revoke all on function koi_private.inbox_dispatch(text,jsonb) from public,anon,authenticated,koi_inbox_gateway;
grant execute on function koi_private.inbox_dispatch(text,jsonb) to koi_inbox_ingest;
commit;
