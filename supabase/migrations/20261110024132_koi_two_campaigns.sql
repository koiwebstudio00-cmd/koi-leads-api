begin;
-- No reescribir una audiencia iniciada: exigir revisión antes de migrar si supera el nuevo límite.
do $$ begin if exists(select 1 from public.koi_campaigns c where c.status in ('scheduled','running','paused') and (select count(*) from public.koi_campaign_recipients r where r.campaign_id=c.id)>100) then raise exception 'An active campaign exceeds 100 recipients; finish or cancel it before migrating'; end if; end $$;
alter table public.koi_campaigns add column active_slot smallint check(active_slot in (1,2)), add column last_claimed_at timestamptz;
update public.koi_campaigns set active_slot=1 where status in ('scheduled','running','paused');
drop index public.koi_one_active_campaign;
alter table public.koi_campaigns add constraint koi_active_slot_required check(status not in ('scheduled','running','paused') or active_slot is not null);
create unique index koi_two_active_campaigns on public.koi_campaigns(workspace_id,active_slot) where status in ('scheduled','running','paused');
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
  if rr.status is distinct from 'unknown' or (p_data->>'decision') is distinct from 'do_not_resend' then raise exception 'Invalid resolution' using errcode='PT409'; end if;
  update public.koi_campaign_recipients set status='cancelled',reason='unknown_closed_without_resend',lease_token=null,lease_until=null,updated_at=now() where id=rr.id;
  update koi_private.senders set blocked=exists(select 1 from public.koi_campaign_recipients where workspace_id=w and status='unknown') where workspace_id=w;
 elsif p_action not in ('detail','recipients','events') then raise exception 'Invalid operation' using errcode='22023';
 end if;
 if p_action='recipients' then
  return jsonb_build_object('recipients',coalesce((select jsonb_agg(to_jsonb(q)-'lease_token') from (select * from public.koi_campaign_recipients where campaign_id=c.id and (coalesce(p_data->>'status','')='' or status=p_data->>'status') order by phone limit 50 offset greatest(0,least(coalesce((p_data->>'page')::int,1),100000)-1)*50) q),'[]'::jsonb),
   'total',(select count(*) from public.koi_campaign_recipients where campaign_id=c.id and (coalesce(p_data->>'status','')='' or status=p_data->>'status')));
 end if;
 if p_action='events' then
  return jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(q)) from (select * from public.koi_campaign_events where campaign_id=c.id and id>coalesce((p_data->>'after')::bigint,0) order by id limit 100) q),'[]'::jsonb));
 end if;
 if p_action='detail' then
  return jsonb_build_object('campaign',to_jsonb(c)-'create_body','counts',coalesce((select jsonb_object_agg(status,n) from (select status,count(*) n from public.koi_campaign_recipients where campaign_id=c.id group by status) q),'{}'::jsonb),
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
  if not s.enabled or s.blocked or s.next_send_at>now() or exists(select 1 from public.koi_campaign_recipients where workspace_id=w and status in ('leased','sending','unknown')) then return null; end if;
  -- Alterna campañas elegibles. Una franja futura o un cupo menor no bloquea a la otra.
  select x.* into c from public.koi_campaigns x
  where x.workspace_id=w and x.status in ('scheduled','running')
   and koi_private.campaign_window(x.config,now())<=now()
   and exists(select 1 from public.koi_campaign_recipients q where q.campaign_id=x.id and q.status='queued' and q.next_attempt_at<=now())
   and (select count(*) from koi_private.message_attempts where workspace_id=w and started_at>now()-interval '1 minute')<least(s.max_minute,(x.config->>'perMinute')::integer)
   and (select count(*) from koi_private.message_attempts where workspace_id=w and started_at>now()-interval '1 hour')<least(s.max_hour,(x.config->>'perHour')::integer)
   and (select count(*) from koi_private.message_attempts where workspace_id=w and started_at>date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman')<least(s.max_day,(x.config->>'perDay')::integer)
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
create or replace function koi_private.campaign_candidates(p_id uuid) returns table(lead_id uuid,phone text,name text,message text,reason text)
language sql stable set search_path='' as $$
 select l.id,l.phone,l.name,coalesce(koi_private.render_message(c.template,to_jsonb(l)),''),
 case when exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone=l.phone) then 'suppressed'
 when koi_private.render_message(c.template,to_jsonb(l)) is null then 'missing_variable' end
 from public.koi_campaigns c join public.koi_lead_list_members m on m.workspace_id=c.workspace_id and m.list_id=c.list_id
 join public.koi_leads l on l.workspace_id=m.workspace_id and l.id=m.lead_id
 where l.deleted_at is null and c.id=p_id and (cardinality(c.selection)=0 or l.id=any(c.selection)) order by l.phone
$$;



commit;
