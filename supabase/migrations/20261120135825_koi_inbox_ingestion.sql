begin;

create role koi_inbox_gateway nologin nosuperuser nobypassrls;
create role koi_inbox_ingest nologin nosuperuser nobypassrls;
grant usage on schema koi_private to koi_inbox_gateway,koi_inbox_ingest;
create table koi_private.inbox_bindings (
 role_name name primary key, workspace_id uuid not null references public.koi_workspaces(id),
 profile_id text not null check(char_length(profile_id) between 1 and 200),
 actor_id uuid not null, kind text not null check(kind in ('gateway','ingest')),
 foreign key(workspace_id,actor_id) references public.koi_workspace_members(workspace_id,user_id)
);
alter table public.koi_inbox_accounts add column issue text;
alter table public.koi_inbox_accounts add column checked_at timestamptz;
alter table public.koi_inbox_conversations add column last_live_inbound_at timestamptz;
alter table public.koi_inbox_conversations add column last_outbound_at timestamptz;
alter table koi_private.inbox_messages add column provider_attachments jsonb not null default '[]' check(jsonb_typeof(provider_attachments)='array');

create table koi_private.inbox_history_context (
 workspace_id uuid not null, account_id uuid not null, conversation_id uuid primary key,
 metadata jsonb not null check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=100000),
 foreign key(workspace_id,account_id,conversation_id) references public.koi_inbox_conversations(workspace_id,account_id,id)
);
create index inbox_history_context_scope on koi_private.inbox_history_context(workspace_id,account_id,conversation_id);
create table koi_private.inbox_connect_states (
 hash text primary key check(hash ~ '^[a-f0-9]{64}$'), workspace_id uuid not null,
 actor_id uuid not null, channel text not null check(channel in ('whatsapp','instagram')),
 reconnect_id text, expires_at timestamptz not null default now()+interval '15 minutes',
 used_at timestamptz, account_id uuid references public.koi_inbox_accounts(id),
 foreign key(workspace_id,actor_id) references public.koi_workspace_members(workspace_id,user_id)
);
create index inbox_connect_actor on koi_private.inbox_connect_states(workspace_id,actor_id);
create index inbox_connect_expiry on koi_private.inbox_connect_states(expires_at);
create table koi_private.inbox_deliveries (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.koi_workspaces(id),
 external_id text not null check(char_length(external_id) between 1 and 200), kind text not null,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=1100000),
 hash text not null check(hash ~ '^[a-f0-9]{64}$'), status text not null default 'pending' check(status in ('pending','processing','processed','ignored','failed')),
 attempts integer not null default 0, retry_at timestamptz not null default now(), lease uuid, lease_until timestamptz,
 error_code text, received_at timestamptz not null default now(), processed_at timestamptz,
 unique(workspace_id,external_id)
);
create index inbox_delivery_ready on koi_private.inbox_deliveries(workspace_id,retry_at,id) where status in ('pending','processing');
create index inbox_delivery_failed on koi_private.inbox_deliveries(workspace_id,id) where status='failed';
create table koi_private.inbox_sync_jobs (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, account_id uuid not null,
 conversation_key text not null default '', conversation jsonb, cursor text, seen_cursors text[] not null default '{}',
 updated_since timestamptz not null default '1970-01-01T00:00:00Z', rescan boolean not null default false,
 status text not null default 'pending' check(status in ('pending','processing','failed')),
 attempts integer not null default 0, retry_at timestamptz not null default now(), lease uuid, lease_until timestamptz,
 error_code text, last_completed_at timestamptz,
 unique(account_id,conversation_key),
 foreign key(workspace_id,account_id) references public.koi_inbox_accounts(workspace_id,id)
);
create index inbox_sync_ready on koi_private.inbox_sync_jobs(workspace_id,retry_at,id) where status in ('pending','processing');
create index inbox_sync_failed on koi_private.inbox_sync_jobs(account_id) where status='failed';
create index inbox_messages_answered on koi_private.inbox_messages(workspace_id,conversation_id,sent_at desc) where direction='out' and status='accepted' and delivery is distinct from 'error';
do $$ declare t text; begin
 foreach t in array array['inbox_history_context','inbox_bindings','inbox_connect_states','inbox_deliveries','inbox_sync_jobs'] loop
 execute format('alter table koi_private.%I enable row level security',t);
 execute format('revoke all on koi_private.%I from public,anon,authenticated,koi_inbox_gateway,koi_inbox_ingest',t);
 end loop;
end $$;

-- Internal helpers have no grants. Only the bound gateway/ingest command calls them.
create function koi_private.inbox_save_account(w uuid,actor uuid,p jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
declare a uuid;
begin
 insert into public.koi_inbox_accounts(workspace_id,external_id,channel,label,address,state,issue,checked_at,created_by)
 values(w,p->>'externalId',p->>'channel',p->>'label',p->>'address',p->>'state',p->>'issue',coalesce((p->>'checkedAt')::timestamptz,now()),actor)
 on conflict(provider,external_id) do update set label=case when excluded.checked_at>=coalesce(koi_inbox_accounts.checked_at,'-infinity') then excluded.label else koi_inbox_accounts.label end,
 address=case when excluded.checked_at>=coalesce(koi_inbox_accounts.checked_at,'-infinity') then excluded.address else koi_inbox_accounts.address end,
 state=case when excluded.checked_at>=coalesce(koi_inbox_accounts.checked_at,'-infinity') then excluded.state else koi_inbox_accounts.state end,
 issue=case when excluded.checked_at>=coalesce(koi_inbox_accounts.checked_at,'-infinity') then excluded.issue else koi_inbox_accounts.issue end,
 checked_at=greatest(koi_inbox_accounts.checked_at,excluded.checked_at),updated_at=now()
 where koi_inbox_accounts.workspace_id=w and koi_inbox_accounts.channel=excluded.channel returning id into a;
 if a is null then raise exception 'Account scope mismatch' using errcode='42501'; end if;
 insert into koi_private.inbox_sync_jobs(workspace_id,account_id) values(w,a) on conflict do nothing;
 return a;
end $$;

create function koi_private.inbox_upsert_message(w uuid,a uuid,actor uuid,c jsonb,m jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
declare acc public.koi_inbox_accounts; ident koi_private.inbox_identities; conv public.koi_inbox_conversations;
 l uuid; phone_value text; result uuid; sent timestamptz;
begin
 select * into strict acc from public.koi_inbox_accounts where id=a and workspace_id=w;
 -- Serialize identities across accounts too when matching an explicit WhatsApp phone.
 perform pg_advisory_xact_lock(hashtextextended(w::text,794));
 select * into ident from koi_private.inbox_identities where workspace_id=w and account_id=a and external_id=c->>'participantId';
 if ident.id is null then
   phone_value:=case when acc.channel='whatsapp' and c->>'phone' ~ '^[1-9][0-9]{9,14}$' then c->>'phone' else null end;
   if phone_value is not null then select id into l from public.koi_leads where workspace_id=w and phone=phone_value and deleted_at is null; end if;
   if l is null then
     -- Never merge by name or social username. Deleted/suppressed CRM contacts are not resurrected.
     if exists(select 1 from public.koi_leads where workspace_id=w and phone=phone_value) then phone_value:=null; end if;
     insert into public.koi_leads(workspace_id,phone,name,source,created_by)
     values(w,phone_value,left(coalesce(c->>'displayName',''),250),'Inbox · '||acc.channel,actor) returning id into l;
   end if;
   insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id,display_name,username)
   values(w,a,acc.channel,l,c->>'participantId',left(coalesce(c->>'displayName',''),250),left(c->>'username',250)) returning * into ident;
 end if;
 insert into public.koi_inbox_conversations(workspace_id,account_id,channel,external_id,identity_id,lead_id,assigned_to)
 select w,a,acc.channel,c->>'externalId',ident.id,ident.lead_id,assigned_to from public.koi_leads where id=ident.lead_id
 on conflict(workspace_id,account_id,external_id) do nothing;
 select * into strict conv from public.koi_inbox_conversations where workspace_id=w and account_id=a and external_id=c->>'externalId' for update;
 if conv.identity_id<>ident.id then raise exception 'Conversation identity mismatch' using errcode='22023'; end if;
 if c->'metadata' is not null and c->'metadata'<>'{}' then
   insert into koi_private.inbox_history_context(workspace_id,account_id,conversation_id,metadata)
   values(w,a,conv.id,c->'metadata') on conflict(conversation_id) do update set metadata=excluded.metadata;
 end if;
 sent:=(m->>'sentAt')::timestamptz;
 if not isfinite(sent) then raise exception 'Invalid timestamp' using errcode='22023'; end if;
 insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,historical,status,delivery,provider_attachments)
 values(w,a,conv.id,m->>'externalId',m->>'direction',coalesce(m->>'body',''),sent,(m->>'historical')::boolean,
 case when m->>'direction'='in' then 'received' else 'accepted' end,m->>'delivery',coalesce(m->'attachments','[]'))
 on conflict(workspace_id,account_id,external_id) do update set
 historical=koi_private.inbox_messages.historical and excluded.historical,
 body=case when excluded.body<>'' then excluded.body else koi_private.inbox_messages.body end,
 provider_attachments=case when jsonb_array_length(excluded.provider_attachments)>0 then excluded.provider_attachments else koi_private.inbox_messages.provider_attachments end,
 delivery=case when koi_private.inbox_messages.delivery='read' or excluded.delivery='read' then 'read'
 when koi_private.inbox_messages.delivery='delivered' or excluded.delivery='delivered' then 'delivered'
 when koi_private.inbox_messages.delivery='error' or excluded.delivery='error' then 'error'
 else coalesce(excluded.delivery,koi_private.inbox_messages.delivery) end
 where koi_private.inbox_messages.conversation_id=conv.id and koi_private.inbox_messages.direction=excluded.direction
 returning id into result;
 if result is null then raise exception 'Message identity mismatch' using errcode='22023'; end if;
 update public.koi_inbox_conversations set
 last_inbound_at=case when m->>'direction'='in' and sent<=now() then greatest(last_inbound_at,sent) else last_inbound_at end,
 last_live_inbound_at=case when m->>'direction'='in' and not (m->>'historical')::boolean and sent<=now() then greatest(last_live_inbound_at,sent) else last_live_inbound_at end,
 last_outbound_at=(select max(msg.sent_at) from koi_private.inbox_messages msg where msg.workspace_id=w and msg.conversation_id=conv.id and msg.direction='out' and msg.status='accepted' and msg.delivery is distinct from 'error' and msg.sent_at<=now()),
 updated_at=now() where id=conv.id;
 return conv.id;
end $$;

create function koi_private.inbox_command(p_action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b koi_private.inbox_bindings; s koi_private.inbox_connect_states; d koi_private.inbox_deliveries;
 j koi_private.inbox_sync_jobs; a public.koi_inbox_accounts; aid uuid; cid uuid; item jsonb; result jsonb; actor uuid;
begin
 select * into b from koi_private.inbox_bindings where role_name=session_user;
 if b.role_name is null or not pg_has_role(session_user,case when b.kind='gateway' then 'koi_inbox_gateway' else 'koi_inbox_ingest' end,'member') then raise exception 'Unbound machine' using errcode='42501'; end if;
 if not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin') then raise exception 'Inactive binding actor' using errcode='42501'; end if;
 if p_action='context' then return jsonb_build_object('workspaceId',b.workspace_id,'profileId',b.profile_id); end if;
 if b.kind='gateway' then
   if p_action not in ('enqueue','list','begin_connect','complete_connect','refresh_account','retry') then raise exception 'Gateway action denied' using errcode='42501'; end if;
   if p_action<>'enqueue' then
     actor:=(p->>'actorId')::uuid;
     if not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=actor and (p_action='list' or role='admin')) then raise exception 'Member denied' using errcode='42501'; end if;
   end if;
 else
   if p_action not in ('account_snapshot','claim_event','finish_event','fail_event','claim_sync','finish_sync','fail_sync') then raise exception 'Ingest action denied' using errcode='42501'; end if;
   actor:=b.actor_id;
 end if;

 if p_action='account_snapshot' then
   select jsonb_build_object('externalId',external_id,'profileId',b.profile_id,'channel',channel,'label',label,'address',address,'state',state,'issue',issue)
    into result from public.koi_inbox_accounts where workspace_id=b.workspace_id and external_id=p->>'externalId';
   return result;
 elsif p_action='enqueue' then
   insert into koi_private.inbox_deliveries(workspace_id,external_id,kind,hash,payload)
   values(b.workspace_id,p->>'externalId',p->>'kind',p->>'hash',p->'payload') on conflict do nothing;
   if exists(select 1 from koi_private.inbox_deliveries where workspace_id=b.workspace_id and external_id=p->>'externalId' and hash<>p->>'hash') then raise exception 'Event collision' using errcode='22023'; end if;
   return '{"persisted":true}';
 elsif p_action='list' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
    select ac.id,ac.external_id,ac.channel,ac.label,ac.address,ac.state,ac.issue,ac.checked_at,
    (select count(*) from koi_private.inbox_sync_jobs js where js.account_id=ac.id and js.conversation_key<>'') pending_history,
    (select count(*) from koi_private.inbox_sync_jobs js where js.account_id=ac.id and js.status='failed') failed_history,
    (select max(last_completed_at) from koi_private.inbox_sync_jobs js where js.account_id=ac.id) last_synced_at
    from public.koi_inbox_accounts ac where ac.workspace_id=b.workspace_id order by ac.created_at
   ) x;
   return jsonb_build_object('accounts',result,'failedEvents',(select count(*) from koi_private.inbox_deliveries where workspace_id=b.workspace_id and status='failed'));
 elsif p_action='begin_connect' then
   if p->>'reconnectId' is not null and not exists(select 1 from public.koi_inbox_accounts where workspace_id=b.workspace_id and external_id=p->>'reconnectId' and channel=p->>'channel') then raise exception 'Account denied' using errcode='42501'; end if;
   delete from koi_private.inbox_connect_states where workspace_id=b.workspace_id and expires_at<now()-interval '1 day';
   insert into koi_private.inbox_connect_states(hash,workspace_id,actor_id,channel,reconnect_id) values(p->>'hash',b.workspace_id,actor,p->>'channel',p->>'reconnectId');
   return '{}';
 elsif p_action in ('complete_connect','refresh_account') then
   if p#>>'{account,profileId}' is distinct from b.profile_id then raise exception 'Profile denied' using errcode='42501'; end if;
   if p_action='complete_connect' then
     select * into s from koi_private.inbox_connect_states where hash=p->>'hash' and workspace_id=b.workspace_id and actor_id=actor for update;
     if s.hash is null or s.expires_at<now() or s.channel<>p#>>'{account,channel}' or (s.reconnect_id is not null and s.reconnect_id<>p#>>'{account,externalId}') then raise exception 'Invalid connect state' using errcode='42501'; end if;
     if s.used_at is not null then
       if exists(select 1 from public.koi_inbox_accounts where id=s.account_id and external_id=p#>>'{account,externalId}') then return jsonb_build_object('id',s.account_id); end if;
       raise exception 'State already used' using errcode='42501';
     end if;
   elsif not exists(select 1 from public.koi_inbox_accounts where workspace_id=b.workspace_id and external_id=p#>>'{account,externalId}') then raise exception 'Unknown account' using errcode='42501';
   end if;
   aid:=koi_private.inbox_save_account(b.workspace_id,actor,p->'account');
   if p_action='complete_connect' then update koi_private.inbox_connect_states set used_at=now(),account_id=aid where hash=s.hash; end if;
   return jsonb_build_object('id',aid);
 elsif p_action='retry' then
   update koi_private.inbox_deliveries set status='pending',attempts=0,retry_at=now(),error_code=null where workspace_id=b.workspace_id and status='failed';
   update koi_private.inbox_sync_jobs set status='pending',attempts=0,retry_at=now(),error_code=null where workspace_id=b.workspace_id and status='failed';
   return '{}';
 elsif p_action='claim_event' then
   select * into d from koi_private.inbox_deliveries where workspace_id=b.workspace_id and
   ((status='pending' and retry_at<=now()) or (status='processing' and lease_until<now())) order by received_at,id for update skip locked limit 1;
   if d.id is null then return null; end if;
   update koi_private.inbox_deliveries set status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=d.id returning * into d;
   return to_jsonb(d);
 elsif p_action in ('finish_event','fail_event') then
   select * into d from koi_private.inbox_deliveries where id=(p->>'id')::uuid and workspace_id=b.workspace_id and status='processing' and lease=(p->>'lease')::uuid and lease_until>now() for update;
   if d.id is null then raise exception 'Stale lease' using errcode='40001'; end if;
   if p_action='fail_event' then
     update koi_private.inbox_deliveries set status=case when attempts>=8 then 'failed' else 'pending' end,
      retry_at=now()+make_interval(secs=>least(3600,greatest(5,coalesce((p->>'retryAfter')::int,30))*power(2,least(attempts-1,6)))::int),
      lease=null,lease_until=null,error_code=left(p->>'code',100) where id=d.id;
     return '{}';
   end if;
   if p->>'ignored'='true' then
     update koi_private.inbox_deliveries set status='ignored',processed_at=now(),lease=null,lease_until=null where id=d.id; return '{}';
   end if;
   if p#>>'{account,profileId}' is distinct from b.profile_id then raise exception 'Profile denied' using errcode='42501'; end if;
   aid:=koi_private.inbox_save_account(b.workspace_id,actor,p->'account');
   if p->'message' is not null then
     cid:=koi_private.inbox_upsert_message(b.workspace_id,aid,actor,p->'conversation',p->'message');
   end if;
   insert into koi_private.inbox_events(workspace_id,account_id,external_id,kind,payload,status,processed_at)
    values(b.workspace_id,aid,d.external_id,d.kind,d.payload,'processed',now()) on conflict do nothing;
   if cid is not null and p->'metadata' is not null and p->'metadata'<>'{}' then
     insert into koi_private.inbox_attribution(workspace_id,account_id,conversation_id,event_external_id,metadata)
      values(b.workspace_id,aid,cid,d.external_id,p->'metadata') on conflict do nothing;
   end if;
   update koi_private.inbox_deliveries set status='processed',processed_at=now(),lease=null,lease_until=null,error_code=null where id=d.id;
   return '{}';
 elsif p_action='claim_sync' then
   select js.* into j from koi_private.inbox_sync_jobs js join public.koi_inbox_accounts ac on ac.id=js.account_id
   where js.workspace_id=b.workspace_id and ac.state='connected' and
   ((js.status='pending' and js.retry_at<=now()) or (js.status='processing' and js.lease_until<now())) order by js.retry_at,js.id for update of js skip locked limit 1;
   if j.id is null then return null; end if;
   update koi_private.inbox_sync_jobs set status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '2 minutes' where id=j.id returning * into j;
   select * into strict a from public.koi_inbox_accounts where id=j.account_id;
   return to_jsonb(j)||jsonb_build_object('externalAccountId',a.external_id,'channel',a.channel);
 elsif p_action in ('finish_sync','fail_sync') then
   select * into j from koi_private.inbox_sync_jobs where id=(p->>'id')::uuid and workspace_id=b.workspace_id and status='processing' and lease=(p->>'lease')::uuid and lease_until>now() for update;
   if j.id is null then raise exception 'Stale lease' using errcode='40001'; end if;
   if p_action='fail_sync' then
     update koi_private.inbox_sync_jobs set status=case when attempts>=8 then 'failed' else 'pending' end,
      retry_at=now()+make_interval(secs=>least(3600,greatest(5,coalesce((p->>'retryAfter')::int,30))*power(2,least(attempts-1,6)))::int),
      lease=null,lease_until=null,error_code=left(p->>'code',100) where id=j.id; return '{}';
   end if;
   if j.conversation_key='' then
     for item in select value from jsonb_array_elements(p->'conversations') loop
       insert into koi_private.inbox_sync_jobs(workspace_id,account_id,conversation_key,conversation)
       values(b.workspace_id,j.account_id,item->>'externalId',item) on conflict(account_id,conversation_key) do update set conversation=excluded.conversation,rescan=true;
     end loop;
   else
     for item in select value from jsonb_array_elements(p->'messages') loop
       perform koi_private.inbox_upsert_message(b.workspace_id,j.account_id,actor,j.conversation,item);
     end loop;
   end if;
   if p->>'cursor' is not null and (p->>'cursor'=j.cursor or p->>'cursor'=any(j.seen_cursors)) then raise exception 'Cursor did not advance' using errcode='22023'; end if;
   if j.conversation_key='' and p->>'cursor' is null and (p->>'updatedSince' is null or (p->>'updatedSince')::timestamptz<j.updated_since or (p->>'updatedSince')::timestamptz>now()) then
    raise exception 'Invalid sync watermark' using errcode='22023'; end if;
   if j.conversation_key<>'' and p->>'cursor' is null and j.rescan then
     update koi_private.inbox_sync_jobs set cursor=null,seen_cursors='{}',rescan=false,status='pending',attempts=0,lease=null,lease_until=null,error_code=null,retry_at=now() where id=j.id;
   elsif j.conversation_key<>'' and p->>'cursor' is null then delete from koi_private.inbox_sync_jobs where id=j.id;
   else update koi_private.inbox_sync_jobs set cursor=p->>'cursor',seen_cursors=case when p->>'cursor' is null then '{}'::text[] else array_append(seen_cursors,p->>'cursor') end,
      updated_since=case when j.conversation_key='' and p->>'cursor' is null then (p->>'updatedSince')::timestamptz else updated_since end,status='pending',attempts=0,lease=null,lease_until=null,error_code=null,
      last_completed_at=case when p->>'cursor' is null then now() else last_completed_at end,
      retry_at=case when p->>'cursor' is null then now()+interval '5 minutes' else now() end where id=j.id;
   end if;
   return '{}';
 end if;
 raise exception 'Unknown action' using errcode='22023';
end $$;
revoke all on function koi_private.inbox_save_account(uuid,uuid,jsonb),koi_private.inbox_upsert_message(uuid,uuid,uuid,jsonb,jsonb),koi_private.inbox_command(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.inbox_command(text,jsonb) to koi_inbox_gateway,koi_inbox_ingest;
commit;
