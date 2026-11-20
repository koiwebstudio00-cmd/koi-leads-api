begin;

alter table public.koi_inbox_accounts add column inbox_human_agent_enabled boolean not null default false;
alter table koi_private.inbox_messages add column quoted_external_id text check (length(quoted_external_id) between 1 and 200);

create function koi_private.inbox_effective_window(c public.koi_inbox_conversations, a public.koi_inbox_accounts,
  evaluated_at timestamptz, allow_human boolean) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare standard jsonb := koi_private.inbox_reply_window(c.last_inbound_at,evaluated_at,a.state);
begin
  if allow_human and c.channel='instagram' and a.inbox_human_agent_enabled and standard->>'reason'='expired'
    and evaluated_at<c.last_inbound_at+interval '168 hours' then
    return standard||jsonb_build_object('canReply',true,'reason','open','mode','human_agent','expiresAt',c.last_inbound_at+interval '168 hours');
  end if;
  return standard||jsonb_build_object('mode', case when (standard->>'canReply')::boolean then 'standard' else 'closed' end);
end $$;

create function koi_private.inbox_quote_external(c public.koi_inbox_conversations, target uuid) returns text
language plpgsql stable security invoker set search_path='' as $$
declare ext text;
begin
  if target is null then return null; end if;
  if c.channel<>'whatsapp' then raise exception 'Quote unsupported' using errcode='22023'; end if;
  select external_id into ext from koi_private.inbox_messages where workspace_id=c.workspace_id and account_id=c.account_id and conversation_id=c.id and id=target;
  if ext is null then raise exception 'Invalid quote' using errcode='PT404'; end if;
  return ext;
end $$;

-- The external target, scoped to the account and thread, survives webhook-before-POST reconciliation.
-- Null emoji rows are tombstones: delayed history must not restore an old reaction.
create table koi_private.inbox_reactions (
 workspace_id uuid not null, account_id uuid not null, thread_external text not null check(length(thread_external) between 1 and 200),
 target_external text not null check(length(target_external) between 1 and 200), outbound boolean,
 sender_external text check (length(sender_external) between 1 and 200),
 reactor_key text generated always as (case when outbound then 'out' when not outbound then 'in' else 'sender:'||sender_external end) stored,
 check(outbound is not null or sender_external is not null),
 emoji text check(length(emoji) between 1 and 32), observed_at timestamptz not null,
 primary key(workspace_id,account_id,thread_external,target_external,reactor_key),
 foreign key(workspace_id,account_id) references public.koi_inbox_accounts(workspace_id,id)
);
create table koi_private.inbox_reaction_jobs (
 id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
 workspace_id uuid not null, account_id uuid not null, conversation_id uuid not null, target_external text not null,
 actor_id uuid not null references auth.users(id), request_id uuid not null, emoji text check(length(emoji) between 1 and 32),
 status text not null default 'queued' check(status in ('queued','leased','sending','accepted','failed','unknown')),
 lease uuid, lease_until timestamptz, started_at timestamptz, attempts integer not null default 0, retry_at timestamptz not null default now(),
 unique(workspace_id,actor_id,request_id), foreign key(workspace_id,account_id,conversation_id) references public.koi_inbox_conversations(workspace_id,account_id,id)
);
create index inbox_reaction_jobs_queue on koi_private.inbox_reaction_jobs(workspace_id,seq) where status in ('queued','leased','sending');
create index inbox_reaction_jobs_target on koi_private.inbox_reaction_jobs(conversation_id,target_external,seq desc);
alter table koi_private.inbox_reactions enable row level security;
alter table koi_private.inbox_reaction_jobs enable row level security;
revoke all on koi_private.inbox_reactions,koi_private.inbox_reaction_jobs from public,anon,authenticated,koi_inbox_ingest,koi_inbox_gateway;

create function koi_private.inbox_record_reaction(w uuid,a uuid,r jsonb) returns void language plpgsql security invoker set search_path='' as $$
begin
  insert into koi_private.inbox_reactions(workspace_id,account_id,thread_external,target_external,outbound,sender_external,emoji,observed_at)
    values(w,a,r->>'externalConversationId',r->>'externalMessageId',(r->>'outbound')::boolean,r->>'senderId',nullif(r->>'emoji',''),least((r->>'at')::timestamptz,clock_timestamp()))
    on conflict(workspace_id,account_id,thread_external,target_external,reactor_key) do update set emoji=excluded.emoji,observed_at=excluded.observed_at
    where koi_private.inbox_reactions.observed_at<excluded.observed_at
       or (koi_private.inbox_reactions.observed_at=excluded.observed_at and excluded.emoji is null);
end $$;

-- Keep the original scoped lookup, event lease and message upsert transaction intact.
do $patch$
declare f text; anchor text;
begin
 select pg_get_functiondef('koi_private.inbox_row(public.koi_inbox_conversations,uuid)'::regprocedure) into f;
 anchor:='koi_private.inbox_reply_window(c.last_inbound_at,now(),a.state)';
 if strpos(f,anchor)=0 then raise exception 'Unexpected Inbox row projection'; end if;
 execute replace(f,anchor,'koi_private.inbox_effective_window(c,a,now(),true)');

 select pg_get_functiondef('koi_private.inbox_command(text,jsonb)'::regprocedure) into f;
 anchor:='if p->''message'' is not null then';
 if strpos(f,anchor)=0 then raise exception 'Unexpected Inbox event command'; end if;
 execute replace(f,anchor,$insert$
   if p->'reaction' is not null then
     perform koi_private.inbox_record_reaction(b.workspace_id,aid,p->'reaction');
     update public.koi_inbox_conversations set updated_at=clock_timestamp()
       where workspace_id=b.workspace_id and account_id=aid and external_id=p#>>'{reaction,externalConversationId}';
   end if;
   $insert$||anchor);

 select pg_get_functiondef('koi_private.inbox_upsert_message(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure) into f;
 anchor:='return conv.id;';
 if strpos(f,anchor)=0 then raise exception 'Unexpected Inbox ingestion function'; end if;
 execute replace(f,anchor,$insert$
   if length(m->>'quotedExternalId') between 1 and 200 then
     update koi_private.inbox_messages set quoted_external_id=coalesce(quoted_external_id,m->>'quotedExternalId') where id=result;
   end if;
   perform koi_private.inbox_record_reaction(w,a,jsonb_build_object('externalConversationId',conv.external_id,
     'externalMessageId',m->>'externalId','outbound',r->'fromMe','at',r->>'reactedAt','emoji',r->>'emoji'))
   from jsonb_array_elements(coalesce(m->'reactions','[]')) r where r->>'reactedAt' is not null;
   $insert$||anchor);
end $patch$;

-- Read only recovers quotes from this exact thread. An unavailable original still has a placeholder.
create function koi_private.inbox_message_interactions(m koi_private.inbox_messages) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('quote',case when m.quoted_external_id is not null then jsonb_build_object('message_id',q.id,
   'text',coalesce(nullif(left(q.body,240),''),case when q.id is null then 'Original no disponible' else 'Adjunto' end)) end,
   'reactions',coalesce((select jsonb_agg(jsonb_build_object('outbound',latest.direction,'emoji',latest.emoji) order by latest.direction)
      from (select distinct on (direction) coalesce(r.outbound,r.sender_external<>identity.external_id) as direction,r.emoji
        from koi_private.inbox_reactions r where r.workspace_id=m.workspace_id and r.account_id=m.account_id and r.thread_external=c.external_id
        and r.target_external=m.external_id order by direction,r.observed_at desc,r.emoji nulls first,r.reactor_key) latest
      where latest.emoji is not null),'[]'::jsonb),
   'reactionStatus',(select j.status from koi_private.inbox_reaction_jobs j where j.conversation_id=c.id and j.target_external=m.external_id order by seq desc limit 1))
 from public.koi_inbox_conversations c join koi_private.inbox_identities identity on identity.id=c.identity_id
 left join koi_private.inbox_messages q on q.workspace_id=m.workspace_id and q.account_id=m.account_id
 and q.conversation_id=m.conversation_id and q.external_id=m.quoted_external_id where c.id=m.conversation_id;
$$;
alter function koi_private.inbox_message_view(koi_private.inbox_messages,boolean) rename to inbox_message_view_pre_interactions;
create function koi_private.inbox_message_view(m koi_private.inbox_messages,preview boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$
 select koi_private.inbox_message_view_pre_interactions(m,preview) || case when preview then '{}'::jsonb else koi_private.inbox_message_interactions(m) end;
$$;

create function public.koi_inbox_react(data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; n integer; c public.koi_inbox_conversations; a public.koi_inbox_accounts;
 m koi_private.inbox_messages; j koi_private.inbox_reaction_jobs; key uuid:=(data->>'requestId')::uuid; emoji text:=data->>'emoji';
begin
 select count(*),min(workspace_id::text)::uuid into n,w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or n<>1 then raise exception 'Membership required' using errcode='42501'; end if;
 if key is null or not (data?'emoji') or jsonb_typeof(data->'emoji') not in ('string','null') or (emoji is not null and (length(emoji) not between 1 and 32 or emoji~'[[:cntrl:][:space:]]')) or
 (data-'id'-'messageId'-'emoji'-'requestId')<>'{}' then raise exception 'Invalid reaction' using errcode='22023'; end if;
 select x.* into c from public.koi_inbox_conversations x join public.koi_leads l on l.id=x.lead_id and l.deleted_at is null
 where x.id=(data->>'id')::uuid and x.workspace_id=w for update of x;
 select * into m from koi_private.inbox_messages where id=(data->>'messageId')::uuid and conversation_id=c.id and workspace_id=w;
 if m.external_id is null then raise exception 'Unknown reaction target' using errcode='PT404'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||key::text,920));
 select * into j from koi_private.inbox_reaction_jobs where workspace_id=w and actor_id=actor and request_id=key;
 if found then
  if j.conversation_id<>c.id or j.target_external<>m.external_id or j.emoji is distinct from emoji then raise exception 'Idempotency conflict' using errcode='PT409'; end if;
 else
  select * into strict a from public.koi_inbox_accounts where id=c.account_id;
  if not (koi_private.inbox_effective_window(c,a,clock_timestamp(),false)->>'canReply')::boolean then raise exception 'Window closed' using errcode='PT422'; end if;
  insert into koi_private.inbox_reaction_jobs(workspace_id,account_id,conversation_id,target_external,actor_id,request_id,emoji)
   values(w,a.id,c.id,m.external_id,actor,key,emoji) returning * into j;
  update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
 end if;
 return jsonb_build_object('id',j.id,'status',j.status);
end $$;
revoke all on function public.koi_inbox_react(jsonb) from public,anon;
grant execute on function public.koi_inbox_react(jsonb) to authenticated;
-- A targeted read exposes the persisted outcome even if the operator reacted several pages back.
create function public.koi_inbox_reaction_status(data jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; n integer; result jsonb;
begin
 select count(*),min(workspace_id::text)::uuid into n,w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or n<>1 then raise exception 'Membership required' using errcode='42501'; end if;
 select koi_private.inbox_message_view(m) into result from public.koi_inbox_conversations c
 join public.koi_leads l on l.workspace_id=c.workspace_id and l.id=c.lead_id and l.deleted_at is null
 join koi_private.inbox_messages m on m.workspace_id=c.workspace_id and m.account_id=c.account_id and m.conversation_id=c.id
 where c.workspace_id=w and c.id=(data->>'id')::uuid and m.id=(data->>'messageId')::uuid;
 if result is null then raise exception 'Unknown reaction target' using errcode='PT404'; end if;
 return result;
end $$;
revoke all on function public.koi_inbox_reaction_status(jsonb) from public,anon;
grant execute on function public.koi_inbox_reaction_status(jsonb) to authenticated;
create function koi_private.inbox_reaction_dispatch(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b koi_private.inbox_bindings; j koi_private.inbox_reaction_jobs; c public.koi_inbox_conversations; a public.koi_inbox_accounts;
  eligibility jsonb; outcome text;
begin
 select * into b from koi_private.inbox_bindings where role_name=session_user and kind='ingest';
 if b.role_name is null or not pg_has_role(session_user,'koi_inbox_ingest','member') or not exists(
   select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin')
 then raise exception 'Unbound worker' using errcode='42501'; end if;
 if action='claim' then
  perform pg_advisory_xact_lock(hashtextextended(b.workspace_id::text,920));
  with expired as (
    update koi_private.inbox_reaction_jobs set status=case when status='leased' then 'queued' else 'unknown' end,lease=null,lease_until=null
    where workspace_id=b.workspace_id and status in ('leased','sending') and lease_until<=clock_timestamp() returning conversation_id
  ) update public.koi_inbox_conversations set updated_at=clock_timestamp() where id in (select conversation_id from expired);
  select * into j from koi_private.inbox_reaction_jobs x where x.workspace_id=b.workspace_id and x.status='queued' and x.retry_at<=clock_timestamp()
  and not exists(select 1 from koi_private.inbox_reaction_jobs prior where prior.conversation_id=x.conversation_id and prior.target_external=x.target_external
    and prior.seq<x.seq and prior.status in ('queued','leased','sending'))
  order by x.seq limit 1 for update skip locked;
  if not found then return null; end if;
  update koi_private.inbox_reaction_jobs set status='leased',lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds'
   where id=j.id returning * into j;
  select * into a from public.koi_inbox_accounts where id=j.account_id;
  select * into c from public.koi_inbox_conversations where id=j.conversation_id;
  return jsonb_build_object('id',j.id,'lease',j.lease,'profileId',b.profile_id,'workspaceId',b.workspace_id,'accountId',a.external_id,'channel',a.channel);
 end if;
 select x.* into c from public.koi_inbox_conversations x join koi_private.inbox_reaction_jobs job on job.conversation_id=x.id
 where job.workspace_id=b.workspace_id and job.id=(p->>'id')::uuid for update of x;
 select * into j from koi_private.inbox_reaction_jobs where workspace_id=b.workspace_id and id=(p->>'id')::uuid and lease=(p->>'lease')::uuid
   and lease_until>clock_timestamp() for update;
 if not found then return null; end if;
 if action='begin' and j.status='leased' then
  select * into strict a from public.koi_inbox_accounts where id=j.account_id;
  eligibility:=koi_private.inbox_effective_window(c,a,clock_timestamp(),false);
  if not (eligibility->>'canReply')::boolean or not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id
    and user_id=j.actor_id and role in ('admin','operator')) or not exists(select 1 from public.koi_leads where id=c.lead_id and deleted_at is null)
    or not exists(select 1 from koi_private.inbox_messages where workspace_id=b.workspace_id and conversation_id=c.id and external_id=j.target_external)
  then outcome:='failed';
  else
   update koi_private.inbox_reaction_jobs set status='sending',started_at=clock_timestamp(),attempts=attempts+1,
     lease_until=clock_timestamp()+interval '45 seconds' where id=j.id;
   return jsonb_build_object('accountId',a.external_id,'conversationId',c.external_id,'messageId',j.target_external,'emoji',j.emoji,
     'expiresAt',eligibility->>'expiresAt');
  end if;
 elsif action='defer' and j.status='leased' then
  outcome:=case when (p->>'terminal')::boolean or j.attempts>=4 then 'failed' else 'queued' end;
  update koi_private.inbox_reaction_jobs set attempts=attempts+1 where id=j.id;
 elsif action='finish' and j.status='sending' then
  outcome:=p->>'outcome';
  if outcome is null or outcome not in ('accepted','unknown','failed','queued') then raise exception 'Invalid result' using errcode='22023'; end if;
  if outcome='accepted' then
   perform koi_private.inbox_record_reaction(b.workspace_id,j.account_id,jsonb_build_object('externalConversationId',c.external_id,
     'externalMessageId',j.target_external,'outbound',true,'emoji',j.emoji,'at',j.started_at));
  elsif outcome='queued' and j.attempts>=5 then outcome:='failed'; end if;
 else return null;
 end if;
 update koi_private.inbox_reaction_jobs set status=outcome,lease=null,lease_until=null,
 retry_at=clock_timestamp()+make_interval(secs=>greatest(5,least(3600,coalesce((p->>'retryAfter')::int,30)))) where id=j.id;
 update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
 if action='begin' then return null; end if;
 return jsonb_build_object('status',outcome);
end $$;

revoke all on function koi_private.inbox_reaction_dispatch(text,jsonb) from public,anon,authenticated,koi_inbox_gateway;
grant execute on function koi_private.inbox_reaction_dispatch(text,jsonb) to koi_inbox_ingest;
revoke all on function koi_private.inbox_effective_window(public.koi_inbox_conversations,public.koi_inbox_accounts,timestamptz,boolean),
 koi_private.inbox_quote_external(public.koi_inbox_conversations,uuid),koi_private.inbox_message_interactions(koi_private.inbox_messages),
 koi_private.inbox_record_reaction(uuid,uuid,jsonb),koi_private.inbox_message_view(koi_private.inbox_messages,boolean) from public,anon,authenticated;
commit;
