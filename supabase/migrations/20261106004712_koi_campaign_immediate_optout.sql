begin;
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
  select * into c from public.koi_campaigns where workspace_id=w and status in ('scheduled','running') for update;
  if not found then return null; end if;
  next_at:=koi_private.campaign_window(c.config,now());
  -- Ventanas móviles y día local; todos los intentos consumen presupuesto incluso si son inciertos.
  for n in 1..3 loop
   cap:=case n when 1 then least(s.max_minute,(c.config->>'perMinute')::int) when 2 then least(s.max_hour,(c.config->>'perHour')::int) else least(s.max_day,(c.config->>'perDay')::int) end;
   boundary:=case n when 1 then now()-interval '1 minute' when 2 then now()-interval '1 hour' else date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman' end;
   if (select count(*) from koi_private.message_attempts where workspace_id=w and started_at>boundary)>=cap then
    if n=3 then next_at:=greatest(next_at,boundary+interval '1 day');
    else select greatest(next_at,max(started_at)+case n when 1 then interval '1 minute' else interval '1 hour' end) into next_at from koi_private.message_attempts where workspace_id=w and started_at>boundary; end if;
   end if;
  end loop;
  if next_at>now() then update koi_private.senders set next_send_at=next_at where workspace_id=w; return null; end if;
  select * into r from public.koi_campaign_recipients where campaign_id=c.id and status='queued' and next_attempt_at<=now() order by next_attempt_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.koi_campaign_recipients set status='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where id=r.id returning * into r;
  update public.koi_campaigns set status='running',updated_at=now() where id=c.id;
  return to_jsonb(r);
 end if;
 select * into r from public.koi_campaign_recipients where workspace_id=w and id=(p_data->>'id')::uuid for update;
 if not found or r.lease_token is distinct from (p_data->>'token')::uuid then return null; end if;
 select * into c from public.koi_campaigns where id=r.campaign_id for update;
 if p_action='begin' then
  if r.status<>'leased' or r.lease_until<now() then return null; end if;
  if c.status<>'running' or not s.enabled or s.blocked then update public.koi_campaign_recipients set status='queued',lease_token=null,lease_until=null where id=r.id; return null; end if;
  if exists(select 1 from public.koi_suppressions where workspace_id=w and phone=r.phone) or not exists(select 1 from public.koi_leads where workspace_id=w and id=r.lead_id and consent='granted') then
   update public.koi_campaign_recipients set status='skipped',reason='consent_or_suppression',lease_token=null,lease_until=null,updated_at=now() where id=r.id; return null;
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
