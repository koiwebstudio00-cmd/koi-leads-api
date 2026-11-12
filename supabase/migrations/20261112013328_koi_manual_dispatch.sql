begin;
-- Stop the mixed worker before applying. Existing data and queued jobs are preserved.
do $$ begin
 if exists(select 1 from koi_private.chat_messages where status in ('leased','sending'))
  or exists(select 1 from public.koi_campaign_recipients where status in ('leased','sending')) then
  raise exception 'Stop and drain dispatch workers before migrating';
 end if;
end $$;
alter table koi_private.senders add column chat_enabled boolean not null default false,
 add column chat_heartbeat_at timestamptz, add column chat_worker_id text;
alter table koi_private.chat_messages add column reason text;
alter table koi_private.machine_bindings drop constraint machine_bindings_kind_check;
alter table koi_private.machine_bindings add constraint machine_bindings_kind_check check(kind in ('worker','chat-worker','webhook'));
create role koi_chat_worker nologin nosuperuser nobypassrls;
grant usage on schema koi_private to koi_chat_worker;
grant execute on function koi_private.worker_command(text,jsonb) to koi_chat_worker;

create table koi_private.dispatch_instances (
 workspace_id uuid not null references koi_private.senders(workspace_id), instance text not null,
 lane text check(lane in ('chat','campaign')), job_id uuid, token uuid, lease_until timestamptz,
 pause_until timestamptz not null default '-infinity', reason text,
 primary key(workspace_id,instance)
);
alter table koi_private.dispatch_instances enable row level security;
revoke all on koi_private.dispatch_instances from public,anon,authenticated;
grant all on koi_private.dispatch_instances to koi_campaign_owner;
create policy dispatch_owner on koi_private.dispatch_instances to koi_campaign_owner using(true) with check(true);
create index koi_chat_order on koi_private.chat_messages(workspace_id,instance,conversation_id,seq)
 where status in ('queued','leased','sending','unknown');

-- These helpers are private to the authorized machine dispatcher, never client RPCs.
create function koi_private.dispatch_lock(w uuid, account text) returns koi_private.dispatch_instances
language plpgsql security definer set search_path='' as $$
declare d koi_private.dispatch_instances; active boolean;
begin
 insert into koi_private.dispatch_instances(workspace_id,instance) values(w,account) on conflict do nothing;
 select * into d from koi_private.dispatch_instances where workspace_id=w and instance=account for update;
 if d.job_id is not null then
  if d.lane='chat' then
   update koi_private.chat_messages set status=case when status='sending' then 'unknown' else 'queued' end,
    reason=case when status='sending' then 'interrupted' else reason end,
    lease_token=case when status='sending' then lease_token end,lease_until=null
   where id=d.job_id and workspace_id=w and lease_token=d.token and status in ('leased','sending') and lease_until<=now();
   select exists(select 1 from koi_private.chat_messages where id=d.job_id and workspace_id=w and lease_token=d.token and status in ('leased','sending')) into active;
  else
   update public.koi_campaign_recipients set status=case when status='sending' then 'unknown' else 'queued' end,
    reason=case when status='sending' then 'interrupted' else reason end,
    lease_token=case when status='sending' then lease_token end,lease_until=null,updated_at=now()
   where id=d.job_id and workspace_id=w and lease_token=d.token and status in ('leased','sending') and lease_until<=now();
   select exists(select 1 from public.koi_campaign_recipients where id=d.job_id and workspace_id=w and lease_token=d.token and status in ('leased','sending')) into active;
  end if;
  if not active then
   update koi_private.dispatch_instances set lane=null,job_id=null,token=null,lease_until=null
    where workspace_id=w and instance=account returning * into d;
  end if;
 end if;
 return d;
end $$;

create function koi_private.chat_pending(w uuid, account text) returns setof koi_private.chat_messages
language sql stable security definer set search_path='' as $$
 select q.* from koi_private.chat_messages q join public.koi_conversations c on c.id=q.conversation_id
 where q.workspace_id=w and q.instance=account and q.status='queued' and q.retry_at<=now()
 and not exists(select 1 from koi_private.chat_messages prior join public.koi_conversations pc on pc.id=prior.conversation_id
  where prior.workspace_id=w and prior.instance=account and (prior.conversation_id=q.conversation_id or pc.phone=c.phone)
  and prior.seq<q.seq and prior.status in ('queued','leased','sending','unknown'))
 and not exists(select 1 from public.koi_campaign_recipients r join koi_private.senders s on s.workspace_id=r.workspace_id
  where r.workspace_id=w and s.instance=account and r.phone=c.phone and r.status='unknown')
 order by q.seq
$$;

create or replace function koi_private.sender_attempts(w uuid, account text, since timestamptz) returns bigint
language sql stable security definer set search_path='' as $$
 select count(*) from koi_private.message_attempts a join koi_private.senders s on s.workspace_id=a.workspace_id
 where a.workspace_id=w and s.instance=account and a.started_at>since
$$;
create or replace function koi_private.chat_inflight(w uuid, account text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from koi_private.chat_messages where workspace_id=w and instance=account and status in ('leased','sending'))
$$;

create function koi_private.dispatch_release(w uuid, account text, job uuid, lease uuid, outcome jsonb default '{}') returns void
language plpgsql security definer set search_path='' as $$
begin
 update koi_private.dispatch_instances set lane=null,job_id=null,token=null,lease_until=null,
  pause_until=case when outcome->>'reason'='provider_429' then greatest(pause_until,now()+make_interval(secs=>greatest(1,least(86400,coalesce((outcome->>'retryAfterSeconds')::int,60)))))
   when outcome->>'reason' in ('provider_401','provider_403','provider_404','disconnected') then greatest(pause_until,now()+interval '20 seconds') else pause_until end,
  reason=case when outcome->>'reason' in ('provider_429','provider_401','provider_403','provider_404','disconnected') then outcome->>'reason' else reason end
 where workspace_id=w and instance=account and job_id=job and token=lease;
 perform pg_catalog.pg_notify('koi_chat_ready','');
end $$;
revoke all on function koi_private.dispatch_lock(uuid,text),koi_private.chat_pending(uuid,text),koi_private.dispatch_release(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function koi_private.dispatch_lock(uuid,text),koi_private.chat_pending(uuid,text),koi_private.dispatch_release(uuid,text,uuid,uuid,jsonb) to koi_campaign_owner;

create function koi_private.chat_uncertain(w uuid, account text, number text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from koi_private.chat_messages m join public.koi_conversations c on c.id=m.conversation_id
 where m.workspace_id=w and m.instance=account and m.status='unknown' and c.phone=number)
$$;
revoke all on function koi_private.chat_uncertain(uuid,text,text) from public,anon,authenticated;
grant execute on function koi_private.chat_uncertain(uuid,text,text) to koi_campaign_owner;

create or replace function koi_private.worker_command(p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; kind text; s koi_private.senders; c public.koi_campaigns; r public.koi_campaign_recipients; old public.koi_campaign_recipients;
 event_row record; n integer; cap integer; next_at timestamptz; boundary timestamptz; status_name text; d koi_private.dispatch_instances;
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
    insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,old.campaign_id,old.id,'message.unknown');
   else
    update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=old.id;
   end if;
  end loop;
  update public.koi_campaigns c0 set status='completed',updated_at=now() where c0.workspace_id=w and c0.status in ('running','scheduled') and not exists(select 1 from public.koi_campaign_recipients r0 where r0.campaign_id=c0.id and r0.status in ('queued','leased','sending'));
  return '{"ok":true}';
 end if;
 if p_action in ('claim','begin','defer','finish') then d:=koi_private.dispatch_lock(w,s.instance); end if;
 if p_action='claim' then
  if d.job_id is not null or d.pause_until>now() or (s.chat_enabled and s.chat_heartbeat_at>now()-interval '60 seconds' and exists(select 1 from koi_private.chat_pending(w,s.instance))) then return null; end if;
  if not s.enabled or s.blocked or s.next_send_at>now() or koi_private.chat_inflight(w,s.instance) or exists(select 1 from public.koi_campaign_recipients where workspace_id=w and status in ('leased','sending')) then return null; end if;
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
  select * into r from public.koi_campaign_recipients where campaign_id=c.id and status='queued' and next_attempt_at<=now() and not koi_private.chat_uncertain(w,s.instance,koi_campaign_recipients.phone) order by next_attempt_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.koi_campaign_recipients set status='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where id=r.id returning * into r;
  update public.koi_campaigns set status='running',last_claimed_at=now(),updated_at=now() where id=c.id;
  update koi_private.dispatch_instances set lane='campaign',job_id=r.id,token=r.lease_token,lease_until=r.lease_until where workspace_id=w and instance=s.instance;
  return to_jsonb(r);
 end if;
 select * into r from public.koi_campaign_recipients where workspace_id=w and id=(p_data->>'id')::uuid for update;
 if not found or r.lease_token is distinct from (p_data->>'token')::uuid then return null; end if;
 select * into c from public.koi_campaigns where id=r.campaign_id for update;
 if p_action='begin' then
  if r.status<>'leased' or r.lease_until<=now() or d.job_id is distinct from r.id or d.token is distinct from r.lease_token then return null; end if;
  if d.pause_until>now() or (s.chat_enabled and s.chat_heartbeat_at>now()-interval '60 seconds' and exists(select 1 from koi_private.chat_pending(w,s.instance))) then
   update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id;
   perform koi_private.dispatch_release(w,s.instance,r.id,r.lease_token);
   return null;
  end if;
  if c.status<>'running' or not s.enabled or s.blocked then update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id; return null; end if;
  if exists(select 1 from public.koi_leads where workspace_id=w and id=r.lead_id and deleted_at is not null) then
   update public.koi_campaign_recipients set status='skipped',reason='lead_deleted',lease_token=null,lease_until=null,updated_at=now() where id=r.id; return null;
  end if;
  if exists(select 1 from public.koi_suppressions where workspace_id=w and phone=r.phone) then
   update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now() where id=r.id; return null;
  end if;
  if exists(select 1 from public.koi_campaign_recipients previous where previous.workspace_id=w and previous.status='unknown'
      and (previous.lead_id=r.lead_id or previous.phone=r.phone)) then
   update public.koi_campaign_recipients set status='skipped',reason='prior_unknown',lease_token=null,lease_until=null,updated_at=now() where id=r.id;
   return null;
  end if;
  if koi_private.chat_uncertain(w,s.instance,r.phone) then
   update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id;
   return null;
  end if;
  if koi_private.campaign_window(c.config,now())>now() then update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id; return null; end if;
  update public.koi_campaign_recipients set status='sending',attempt=attempt+1,lease_until=now()+interval '90 seconds',updated_at=now() where id=r.id returning * into r;
  update koi_private.dispatch_instances set lease_until=r.lease_until where workspace_id=w and instance=s.instance;
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
  if p_data->>'reason'='provider_429' then
   update koi_private.senders set next_send_at=greatest(next_send_at,now()+make_interval(secs=>greatest(1,least(86400,coalesce((p_data->>'retryAfterSeconds')::int,60))))) where workspace_id=w;
  end if;
  insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,c.id,r.id,'message.'||status_name);
 else return null;
 end if;
 perform koi_private.dispatch_release(w,s.instance,r.id,r.lease_token,p_data || case when p_action='defer' then '{"reason":"disconnected"}'::jsonb else '{}'::jsonb end);
 return '{"ok":true}';
end $$;
create or replace function koi_private.chat_machine(action text, data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  w uuid; binding text; sender koi_private.senders; c public.koi_conversations; m koi_private.chat_messages;
  account text:=data->>'instance'; provider text; outcome text; receipt text; event jsonb;
  d koi_private.dispatch_instances; candidate record;
begin
  select workspace_id,kind into w,binding from koi_private.machine_bindings where role_name=session_user;
  if w is null then raise exception 'Unbound machine' using errcode='42501'; end if;
  select * into sender from koi_private.senders where workspace_id=w;
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
  if binding<>'chat-worker' or account is distinct from sender.instance then raise exception 'Worker required' using errcode='42501'; end if;
  if action='chat_tick' then
    update koi_private.senders set chat_enabled=coalesce((data->>'enabled')::boolean,false),chat_heartbeat_at=now(),chat_worker_id=left(data->>'workerId',100) where workspace_id=w;
    update koi_private.chat_messages set status=case when status='sending' then 'unknown' else 'queued' end,
      lease_token=case when status='sending' then lease_token end,lease_until=null
    where workspace_id=w and status in ('leased','sending') and lease_until<now();
    return '{"ok":true}';
  end if;
  if action='chat_accounts' then return coalesce((select jsonb_agg(jsonb_build_object('instance',i.instance)) from koi_private.chat_instances(w) i),'[]'); end if;
  if action='chat_claim' then
    if not sender.chat_enabled then return null; end if;
    for candidate in select i.instance from koi_private.chat_instances(w) i
     where coalesce(data->>'account','')='' or i.instance=data->>'account' order by i.instance loop
      d:=koi_private.dispatch_lock(w,candidate.instance);
      if d.job_id is not null or d.pause_until>now() then continue; end if;
      select * into m from koi_private.chat_pending(w,candidate.instance) limit 1;
      if not found then continue; end if;
      update koi_private.chat_messages set status='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds'
        where id=m.id and status='queued' returning * into m;
      if found then
        update koi_private.dispatch_instances set lane='chat',job_id=m.id,token=m.lease_token,lease_until=m.lease_until
         where workspace_id=w and instance=m.instance;
        exit;
      end if;
    end loop;
    if m.id is null then return null; end if;
    return jsonb_build_object('id',m.id,'token',m.lease_token,'instance',m.instance);
  end if;
  select instance into account from koi_private.chat_messages where workspace_id=w and id=(data->>'id')::uuid;
  if account is null then return null; end if;
  d:=koi_private.dispatch_lock(w,account);
  select * into m from koi_private.chat_messages where workspace_id=w and id=(data->>'id')::uuid for update;
  if not found or m.lease_token is null or m.lease_token is distinct from (data->>'token')::uuid then return null; end if;
  if action='chat_defer' and m.status='leased' then
    update koi_private.chat_messages set status='queued',retry_at=now()+interval '1 second',lease_token=null,lease_until=null where id=m.id;
    perform koi_private.dispatch_release(w,m.instance,m.id,m.lease_token,'{"reason":"disconnected"}');
    return null;
  end if;
  if action='chat_begin' and m.status='leased' and m.lease_until>now() then
    if d.job_id is distinct from m.id or d.token is distinct from m.lease_token then return null; end if;
    if not sender.chat_enabled or d.pause_until>now() then
      update koi_private.chat_messages set status='queued',lease_token=null,lease_until=null where id=m.id;
      perform koi_private.dispatch_release(w,m.instance,m.id,m.lease_token);
      return null;
    end if;
    select * into c from public.koi_conversations where id=m.conversation_id;
    if c.phone is null or exists(select 1 from public.koi_suppressions where workspace_id=w and phone=c.phone)
      or (c.lead_id is not null and not exists(select 1 from public.koi_leads where id=c.lead_id and workspace_id=w and deleted_at is null and phone=c.phone)) then
      update koi_private.chat_messages set status='failed',reason='contact_unavailable',lease_token=null,lease_until=null where id=m.id;
      return null;
    end if;
    update koi_private.chat_messages set status='sending',attempted_at=now(),lease_until=now()+interval '90 seconds' where id=m.id;
    update koi_private.dispatch_instances set lease_until=now()+interval '90 seconds' where workspace_id=w and instance=m.instance;
    return jsonb_build_object('queueWaitMs',greatest(0,extract(epoch from (clock_timestamp()-m.sent_at))*1000),'phone',c.phone,'text',m.body,'mime',m.attachment_mime,'fileName',m.attachment_name,
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
    update koi_private.chat_messages set status=outcome,reason=left(data->>'reason',100),provider_id=case when outcome='accepted' then provider end,
      delivery=receipt,lease_until=null,lease_token=case when outcome='unknown' then lease_token end where id=m.id;
    perform koi_private.dispatch_release(w,m.instance,m.id,m.lease_token,data);
    return '{"ok":true}';
  end if;
  return null;
end $$;
create or replace function koi_private.chat_message_json(message koi_private.chat_messages) returns jsonb
language sql stable set search_path='' as $$
  select (to_jsonb(message) - array['workspace_id','instance','lease_token','lease_until','request_id','request_hash','retry_at','attempted_at','provider_id','quote_provider_id','quote_text'])
    || jsonb_build_object(
      'clientKey',message.request_id,
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


create function koi_private.notify_chat_queue() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='queued' then perform pg_catalog.pg_notify('koi_chat_ready',''); end if;
 return new;
end $$;
create trigger koi_chat_queue_notify after insert or update of status on koi_private.chat_messages
 for each row execute function koi_private.notify_chat_queue();
revoke all on function koi_private.notify_chat_queue() from public,anon,authenticated;

create function koi_private.notify_chat_reaction() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.koi_conversations set updated_at=updated_at
 where workspace_id=new.workspace_id and instance=new.instance and peer=new.peer;
 return new;
end $$;
create trigger koi_chat_reaction_notify after insert or update on koi_private.chat_reactions
 for each row execute function koi_private.notify_chat_reaction();
revoke all on function koi_private.notify_chat_reaction() from public,anon,authenticated;
commit;
