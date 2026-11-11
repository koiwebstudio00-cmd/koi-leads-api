begin;
alter table public.koi_campaign_recipients add column reviewed_at timestamptz;

create function koi_private.match_chat_lead(w uuid, number text) returns uuid
language sql stable security invoker set search_path='' as $$
 with candidates as (
   select id, phone=number as exact from public.koi_leads
   where workspace_id=w and deleted_at is null and (
     phone=number or (number ~ '^549?[0-9]{10}$' and phone ~ '^549?[0-9]{10}$'
       and right(phone,10)=right(number,10))
   )
 )
 select coalesce((select id from candidates where exact limit 1),
   (select (array_agg(id))[1] from candidates having count(*)=1))
$$;
revoke all on function koi_private.match_chat_lead(uuid,text) from public,anon,authenticated;
grant execute on function koi_private.match_chat_lead(uuid,text) to koi_campaign_owner;

create or replace function koi_private.campaign_command(p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; actor uuid:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; c public.koi_campaigns; s koi_private.senders; body jsonb; cfg jsonb; cid uuid;
 ids uuid[]; candidates jsonb; total integer; eligible integer; result jsonb; rr public.koi_campaign_recipients;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or w is null then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_action='list' then
  return jsonb_build_object('campaigns',coalesce((select jsonb_agg(to_jsonb(q)-'create_body') from (select * from public.koi_campaigns where workspace_id=w order by created_at desc,id limit 50 offset greatest(0,least(coalesce((p_data->>'page')::int,1),100000)-1)*50) q),'[]'::jsonb),
    'total',(select count(*) from public.koi_campaigns where workspace_id=w));
 end if;
 -- Orden de bloqueo común con worker: remitente, campaña, destinatario.
 select * into s from koi_private.senders where workspace_id=w for update;
 if p_action='create' then
  body:=p_data-'key';
  select * into c from public.koi_campaigns where workspace_id=w and create_key=(p_data->>'key')::uuid;
  if found then
   if c.create_body<>body then raise exception 'Idempotency conflict' using errcode='PT409'; end if;
   return to_jsonb(c)-'create_body';
  end if;
 else
  select * into c from public.koi_campaigns where workspace_id=w and id=(p_data->>'id')::uuid for update;
  if not found then raise exception 'Not found' using errcode='PT404'; end if;
 end if;
 if p_action in ('create','update') then
  if p_action='update' and (c.status<>'draft' or c.revision is distinct from (p_data->>'revision')::int) then raise exception 'Stale draft' using errcode='PT409'; end if;
  cfg:=p_data->'config';
  if cfg is null or jsonb_typeof(cfg)<>'object' or (cfg->>'timezone') is distinct from 'America/Argentina/Tucuman'
    or coalesce((cfg->>'intervalSeconds')::int,0) not between 1 and 86400
    or coalesce((cfg->>'perMinute')::int,0) not between 1 and 60 or coalesce((cfg->>'perHour')::int,0) not between 1 and 3600 or coalesce((cfg->>'perDay')::int,0) not between 1 and 10000
    or coalesce((cfg->>'startMinute')::int,-1) not between 0 and 1439 or coalesce((cfg->>'endMinute')::int,-1) not between 1 and 1440
    or (cfg->>'startMinute')::int >= (cfg->>'endMinute')::int
    or jsonb_typeof(cfg->'days') is distinct from 'array' or jsonb_array_length(cfg->'days') not between 1 and 7
    or exists(select 1 from jsonb_array_elements_text(cfg->'days') x where x::int not between 0 and 6)
    then raise exception 'Invalid schedule' using errcode='22023'; end if;
  perform (cfg->>'startsAt')::timestamptz;
  if not exists(select 1 from public.koi_lead_lists where workspace_id=w and id=(p_data->>'listId')::uuid) then raise exception 'Invalid list' using errcode='42501'; end if;
  select coalesce(array_agg(distinct x::uuid),'{}') into ids from jsonb_array_elements_text(coalesce(p_data->'recipientIds','[]')) x;
  if cardinality(ids)>100 or exists(select 1 from unnest(ids) i where not exists(select 1 from public.koi_lead_list_members m where m.workspace_id=w and m.list_id=(p_data->>'listId')::uuid and m.lead_id=i)) then raise exception 'Invalid recipients' using errcode='22023'; end if;
  if p_action='create' then
   insert into public.koi_campaigns(workspace_id,list_id,name,template,selection,config,create_key,create_body,created_by)
   values(w,(p_data->>'listId')::uuid,btrim(p_data->>'name'),p_data->>'template',ids,cfg,(p_data->>'key')::uuid,body,actor) returning * into c;
  else
   update public.koi_campaigns set name=btrim(p_data->>'name'),list_id=(p_data->>'listId')::uuid,template=p_data->>'template',selection=ids,config=cfg,revision=revision+1,updated_at=now() where id=c.id returning * into c;
  end if;
 elsif p_action='preview' then
  if c.status<>'draft' then raise exception 'Not draft' using errcode='PT409'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.phone),'[]'::jsonb),count(*),count(*) filter(where reason is null) into candidates,total,eligible from koi_private.campaign_candidates(c.id) q;
  return jsonb_build_object('total',total,'eligible',eligible,'excluded',total-eligible,'revision',c.revision,'fingerprint',md5(candidates::text),
   'rows',coalesce((select jsonb_agg(to_jsonb(q)) from (select * from koi_private.campaign_candidates(c.id) limit 50) q),'[]'::jsonb));
 elsif p_action='start' then
  if c.start_key is not null then
   if c.start_key=(p_data->>'key')::uuid then return to_jsonb(c)-'create_body'; end if;
   raise exception 'Already started' using errcode='PT409';
  end if;
  if p_data->>'key' is null then raise exception 'Missing key' using errcode='22023'; end if;
  if c.status<>'draft' or c.revision is distinct from (p_data->>'revision')::int then raise exception 'Stale draft' using errcode='PT409'; end if;
  if s.workspace_id is null then raise exception 'Sender not configured' using errcode='PT503'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.phone),'[]'::jsonb),count(*),count(*) filter(where reason is null) into candidates,total,eligible from koi_private.campaign_candidates(c.id) q;
  if (p_data->>'fingerprint') is distinct from md5(candidates::text) then raise exception 'Preview changed' using errcode='PT409'; end if;
  if total>100 or eligible=0 then raise exception 'No eligible recipients or too many' using errcode='22023'; end if;
  insert into public.koi_campaign_recipients(workspace_id,campaign_id,lead_id,phone,name,message,status,reason,next_attempt_at)
   select w,c.id,lead_id,phone,name,message,case when reason is null then 'queued' else 'skipped' end,reason,koi_private.campaign_window(c.config,now()) from jsonb_to_recordset(candidates) as q(lead_id uuid,phone text,name text,message text,reason text);
  select v into total from generate_series(1,2) v where not exists(select 1 from public.koi_campaigns x where x.workspace_id=w and x.active_slot=v and x.status in ('scheduled','running','paused')) order by v limit 1;
  if total is null then raise exception 'Two campaigns already active' using errcode='PT429'; end if;
  update public.koi_campaigns set active_slot=total,status='scheduled',start_key=(p_data->>'key')::uuid,revision=revision+1,updated_at=now() where id=c.id returning * into c;
 elsif p_action='pause' then
  if c.status not in ('scheduled','running','paused') then raise exception 'Cannot pause' using errcode='PT409'; end if;
  update public.koi_campaigns set status='paused',pause_reason='operator',updated_at=now() where id=c.id returning * into c;
 elsif p_action='resume' then
  if c.status<>'paused' or s.blocked then raise exception 'Cannot resume' using errcode='PT409'; end if;
  update public.koi_campaigns set status='scheduled',pause_reason=null,updated_at=now() where id=c.id returning * into c;
 elsif p_action='cancel' then
  if c.status='completed' then raise exception 'Completed' using errcode='PT409'; end if;
  update public.koi_campaign_recipients set status='cancelled',lease_token=null,lease_until=null,updated_at=now() where campaign_id=c.id and status in ('queued','leased');
  update public.koi_campaigns set status='cancelled',updated_at=now() where id=c.id returning * into c;
 elsif p_action='resolve' then
  if not exists(select 1 from public.koi_workspace_members where workspace_id=w and user_id=actor and role='admin') then raise exception 'Admin required' using errcode='42501'; end if;
  select * into rr from public.koi_campaign_recipients where campaign_id=c.id and id=(p_data->>'recipientId')::uuid for update;
  if rr.status is null or rr.status not in ('unknown','failed') or rr.reviewed_at is not null or (p_data->>'decision') is distinct from 'do_not_resend' then raise exception 'Invalid resolution' using errcode='PT409'; end if;
  update public.koi_campaign_recipients set reviewed_at=now(),
    status=case when rr.status='unknown' then 'cancelled' else rr.status end,
    reason=case when rr.status='unknown' then 'unknown_closed_without_resend' else rr.reason end,
    lease_token=null,lease_until=null,updated_at=now() where id=rr.id;
 elsif p_action not in ('detail','recipients','events') then raise exception 'Invalid operation' using errcode='22023';
 end if;
 if p_action='recipients' then
  return jsonb_build_object('recipients',coalesce((select jsonb_agg(to_jsonb(q)-'lease_token') from (select * from public.koi_campaign_recipients where campaign_id=c.id and (coalesce(p_data->>'status','')='' or status=p_data->>'status' or (p_data->>'status'='review' and status in ('failed','unknown') and reviewed_at is null)) order by phone limit 50 offset greatest(0,least(coalesce((p_data->>'page')::int,1),100000)-1)*50) q),'[]'::jsonb),
   'total',(select count(*) from public.koi_campaign_recipients where campaign_id=c.id and (coalesce(p_data->>'status','')='' or status=p_data->>'status' or (p_data->>'status'='review' and status in ('failed','unknown') and reviewed_at is null))));
 end if;
 if p_action='events' then
  return jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(q)) from (select * from public.koi_campaign_events where campaign_id=c.id and id>coalesce((p_data->>'after')::bigint,0) order by id limit 100) q),'[]'::jsonb));
 end if;
 if p_action='detail' then
  return jsonb_build_object('campaign',to_jsonb(c)-'create_body','counts',coalesce((select jsonb_object_agg(status,n) from (select status,count(*) n from public.koi_campaign_recipients where campaign_id=c.id group by status) q),'{}'::jsonb),
   'reviewPending',(select count(*) from public.koi_campaign_recipients where campaign_id=c.id and status in ('failed','unknown') and reviewed_at is null),
   'delivery',coalesce((select jsonb_object_agg(delivery,n) from (select delivery,count(*) n from public.koi_campaign_recipients where campaign_id=c.id and delivery is not null group by delivery) q),'{}'::jsonb),
   'sender',jsonb_build_object('configured',s.workspace_id is not null,'enabled',coalesce(s.enabled,false),'blocked',coalesce(s.blocked,false),'heartbeatAt',s.heartbeat_at,'nextSendAt',s.next_send_at,'limits',jsonb_build_object('intervalSeconds',s.min_interval,'perMinute',s.max_minute,'perHour',s.max_hour,'perDay',s.max_day)));
 end if;
 insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,actor_id,kind) values(w,c.id,rr.id,actor,'campaign.'||p_action);
 return to_jsonb(c)-'create_body';
end $$;

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
    insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,old.campaign_id,old.id,'message.unknown');
   else
    update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=old.id;
   end if;
  end loop;
  update public.koi_campaigns c0 set status='completed',updated_at=now() where c0.workspace_id=w and c0.status in ('running','scheduled') and not exists(select 1 from public.koi_campaign_recipients r0 where r0.campaign_id=c0.id and r0.status in ('queued','leased','sending'));
  return '{"ok":true}';
 end if;
 if p_action='claim' then
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
  if exists(select 1 from public.koi_campaign_recipients previous where previous.workspace_id=w and previous.status='unknown'
      and (previous.lead_id=r.lead_id or previous.phone=r.phone)) then
   update public.koi_campaign_recipients set status='skipped',reason='prior_unknown',lease_token=null,lease_until=null,updated_at=now() where id=r.id;
   return null;
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
  if p_data->>'reason'='provider_429' then
   update koi_private.senders set next_send_at=greatest(next_send_at,now()+make_interval(secs=>greatest(1,least(86400,coalesce((p_data->>'retryAfterSeconds')::int,60))))) where workspace_id=w;
  end if;
  insert into public.koi_campaign_events(workspace_id,campaign_id,recipient_id,kind) values(w,c.id,r.id,'message.'||status_name);
 else return null;
 end if;
 return '{"ok":true}';
end $$;

create or replace function koi_private.chat_machine(action text, data jsonb) returns jsonb
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
        and not exists(select 1 from public.koi_campaign_recipients r where r.workspace_id=w and (r.status in ('leased','sending') or (r.status='unknown' and r.phone=q.phone)))))
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
  select id,assigned_to into lead,assignee from public.koi_leads where workspace_id=w and id=koi_private.match_chat_lead(w,phone_number) and deleted_at is null for update;
  message_time:=least(now(),coalesce((data->>'sentAt')::timestamptz,now()));
  insert into public.koi_conversations(workspace_id,instance,peer,phone,name,lead_id,assigned_to,updated_at)
  values(w,account,peer_id,phone_number,left(coalesce(data->>'name',''),120),lead,assignee,message_time)
  on conflict(workspace_id,instance,peer) do update set lead_id=coalesce(koi_conversations.lead_id,excluded.lead_id), phone=coalesce(excluded.phone,koi_conversations.phone),
    name=coalesce(nullif(excluded.name,''),koi_conversations.name) returning * into c;
  select delivery into delivery_state from koi_private.chat_receipts where workspace_id=w and instance=account and provider_id=provider;
  insert into koi_private.chat_messages(workspace_id,conversation_id,instance,direction,body,sent_at,historical,status,provider_id,delivery,attachment_name,attachment_mime)
  values(w,c.id,account,case when outbound then 'out' else 'in' end,left(coalesce(data->>'text',''),10000),message_time,coalesce((data->>'historical')::boolean,false),
    case when outbound then 'accepted' else 'received' end,provider,case when outbound then delivery_state end,
    left(data->>'fileName',120),data->>'mime') on conflict(workspace_id,instance,provider_id) do nothing;
  if not outbound and not coalesce((data->>'historical')::boolean,false) and phone_number is not null and lower(btrim(data->>'text')) in ('baja','stop','no me contacten','no me escriban más','no me escriban mas') then
    insert into public.koi_suppressions(workspace_id,phone,reason) select w,p,'Baja solicitada por WhatsApp' from (
      select phone_number as p union select l.phone from public.koi_leads l where l.id=c.lead_id and l.workspace_id=w
    ) phones on conflict do nothing;
    update public.koi_campaign_recipients set status='skipped',reason='suppressed',lease_token=null,lease_until=null,updated_at=now()
    where workspace_id=w and (phone=phone_number or lead_id=c.lead_id) and status in ('queued','leased');
  end if;
  return '{"stored":true}';
end $$;

-- Preserve unresolved attempts and release only the previous uncertainty lock.
update koi_private.senders set blocked=false where blocked
  and exists(select 1 from public.koi_campaign_recipients r where r.workspace_id=senders.workspace_id and r.status='unknown');
update public.koi_campaigns c set
  status=case when exists(select 1 from public.koi_campaign_recipients r where r.campaign_id=c.id and r.status in ('queued','leased','sending')) then 'paused' else 'completed' end,
  pause_reason=null,updated_at=now()
where status='paused' and pause_reason='unknown_result';

create or replace function koi_private.lead_replied() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.direction='in' and not new.historical and new.status='received' and lower(btrim(new.body)) not in ('baja','stop','no me contacten','no me escriban más','no me escriban mas') then
  update public.koi_leads l set stage='replied' from public.koi_conversations c
  where c.id=new.conversation_id and c.workspace_id=new.workspace_id and l.id=c.lead_id and l.workspace_id=c.workspace_id and l.deleted_at is null and l.stage in ('new','contacted')
   and not exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone in (l.phone,c.phone));
 end if;
 return new;
end $$;

-- Link only unassigned chats. The ownership trigger copies the lead assignee.
update public.koi_conversations c set lead_id=koi_private.match_chat_lead(c.workspace_id,c.phone)
where c.lead_id is null and c.phone is not null and koi_private.match_chat_lead(c.workspace_id,c.phone) is not null;
update public.koi_leads l set stage='replied'
where l.deleted_at is null and l.stage in ('new','contacted')
and exists (
  select 1 from public.koi_conversations c
  join koi_private.chat_messages m on m.conversation_id=c.id and m.workspace_id=c.workspace_id
  where c.lead_id=l.id and c.workspace_id=l.workspace_id and m.direction='in' and not m.historical and m.status='received'
    and lower(btrim(m.body)) not in ('baja','stop','no me contacten','no me escriban más','no me escriban mas')
    and not exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone in (l.phone,c.phone))
);
commit;
