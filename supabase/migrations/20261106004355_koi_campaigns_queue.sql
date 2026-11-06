begin;

-- No credenciales ni acceso de máquina activo en la migración.
create role koi_campaign_owner nologin nosuperuser nobypassrls;
create role koi_campaign_worker nologin nosuperuser nobypassrls;
create role koi_campaign_webhook nologin nosuperuser nobypassrls;
grant usage on schema public, auth, koi_private to koi_campaign_owner;
grant usage on schema koi_private to authenticated, koi_campaign_worker, koi_campaign_webhook;
grant execute on function auth.uid() to koi_campaign_owner;
grant select on public.koi_workspace_members, public.koi_lead_lists, public.koi_leads, public.koi_lead_list_members, public.koi_suppressions to koi_campaign_owner;
grant insert on public.koi_suppressions to koi_campaign_owner;
create policy campaign_owner_members on public.koi_workspace_members for select to koi_campaign_owner using (true);
create policy campaign_owner_lists on public.koi_lead_lists for select to koi_campaign_owner using (true);
create policy campaign_owner_leads on public.koi_leads for select to koi_campaign_owner using (true);
create policy campaign_owner_list_members on public.koi_lead_list_members for select to koi_campaign_owner using (true);
create policy campaign_owner_suppressions on public.koi_suppressions for all to koi_campaign_owner using (true) with check (true);

create table public.koi_campaigns (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.koi_workspaces,
 list_id uuid not null, name text not null check(length(btrim(name)) between 1 and 100),
 template text not null check(length(template) between 1 and 4000),
 selection uuid[] not null default '{}', config jsonb not null,
 status text not null default 'draft' check(status in ('draft','scheduled','running','paused','completed','cancelled')),
 pause_reason text, revision integer not null default 0,
 create_key uuid not null, create_body jsonb not null, start_key uuid,
 created_by uuid not null references auth.users, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,id), unique(workspace_id,create_key),
 foreign key(workspace_id,list_id) references public.koi_lead_lists(workspace_id,id)
);
create unique index koi_one_active_campaign on public.koi_campaigns(workspace_id) where status in ('scheduled','running','paused');
create index koi_campaign_list on public.koi_campaigns(workspace_id,list_id);
create index koi_campaign_creator on public.koi_campaigns(created_by);
create index koi_campaign_recent on public.koi_campaigns(workspace_id,created_at desc,id);

create table public.koi_campaign_recipients (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
 campaign_id uuid not null, lead_id uuid not null,
 phone text not null, name text not null, message text not null,
 status text not null check(status in ('queued','leased','sending','accepted','unknown','failed','skipped','cancelled')),
 reason text, delivery text check(delivery in ('sent','delivered','read','error')),
 provider_id text, attempt integer not null default 0,
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default now(),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(campaign_id,phone), unique(workspace_id,id), unique(workspace_id,provider_id),
 foreign key(workspace_id,campaign_id) references public.koi_campaigns(workspace_id,id),
 foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id)
);
create index koi_campaign_queue on public.koi_campaign_recipients(workspace_id,next_attempt_at,id) where status='queued';
create index koi_campaign_recipient_status on public.koi_campaign_recipients(campaign_id,status,id);
create index koi_campaign_recipient_lead on public.koi_campaign_recipients(workspace_id,lead_id);

create table public.koi_campaign_events (
 id bigint generated always as identity primary key, workspace_id uuid not null, campaign_id uuid not null,
 recipient_id uuid, actor_id uuid references auth.users,
 kind text not null, details jsonb not null default '{}', created_at timestamptz not null default now(),
 foreign key(workspace_id,campaign_id) references public.koi_campaigns(workspace_id,id),
 foreign key(workspace_id,recipient_id) references public.koi_campaign_recipients(workspace_id,id)
);
create index koi_campaign_events_cursor on public.koi_campaign_events(campaign_id,id);
create index koi_campaign_events_recipient on public.koi_campaign_events(workspace_id,recipient_id);
create index koi_campaign_events_actor on public.koi_campaign_events(actor_id);

create table koi_private.senders (
 workspace_id uuid primary key references public.koi_workspaces,
 instance text not null unique, enabled boolean not null default false, blocked boolean not null default false,
 next_send_at timestamptz not null default now(), heartbeat_at timestamptz, worker_id text,
 min_interval integer not null default 30 check(min_interval>=1),
 max_minute integer not null default 2 check(max_minute>0), max_hour integer not null default 60 check(max_hour>0), max_day integer not null default 100 check(max_day>0)
);
create table koi_private.machine_bindings (
 role_name text primary key, workspace_id uuid not null references koi_private.senders, kind text not null check(kind in ('worker','webhook'))
);
create table koi_private.message_attempts (
 recipient_id uuid not null references public.koi_campaign_recipients, attempt integer not null,
 workspace_id uuid not null references koi_private.senders, started_at timestamptz not null default now(),
 finished_at timestamptz, outcome text, provider_id text,
 primary key(recipient_id,attempt)
);
create index koi_attempts_rate on koi_private.message_attempts(workspace_id,started_at);
create table koi_private.evolution_events (
 id bigint generated always as identity primary key, workspace_id uuid not null references koi_private.senders,
 event_key text not null, payload jsonb not null, received_at timestamptz not null default now(), processed_at timestamptz,
 unique(workspace_id,event_key)
);
create index koi_evolution_pending on koi_private.evolution_events(workspace_id,id) where processed_at is null;

do $$ declare t text; begin
 foreach t in array array['koi_campaigns','koi_campaign_recipients','koi_campaign_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to koi_campaign_owner',t);
  execute format('create policy owner_access on public.%I to koi_campaign_owner using(true) with check(true)',t);
  execute format('create policy member_read on public.%I for select to authenticated using(exists(select 1 from public.koi_workspace_members m where m.workspace_id=%I.workspace_id and m.user_id=(select auth.uid())))',t,t);
 end loop;
 foreach t in array array['senders','machine_bindings','message_attempts','evolution_events'] loop
  execute format('alter table koi_private.%I enable row level security',t);
  execute format('revoke all on koi_private.%I from public,anon,authenticated',t);
  execute format('grant all on koi_private.%I to koi_campaign_owner',t);
  execute format('create policy owner_access on koi_private.%I to koi_campaign_owner using(true) with check(true)',t);
 end loop;
end $$;
grant usage,select on sequence public.koi_campaign_events_id_seq,koi_private.evolution_events_id_seq to koi_campaign_owner;

create function koi_private.render_message(p_template text,p_lead jsonb) returns text language plpgsql immutable set search_path='' as $$
declare m text[]; result text:=p_template; value text; k text;
begin
 for m in select regexp_matches(p_template,'\{\{([^{}]+)\}\}','g') loop
  k:=btrim(m[1]);
  value:=case k when 'nombre' then p_lead->>'name' when 'empresa' then p_lead->>'company' when 'telefono' then p_lead->>'phone' when 'email' then p_lead->>'email' when 'origen' then p_lead->>'source' else case when k ~ '^extra\.[A-Za-z0-9_ -]{1,80}$' then p_lead->'extra'->>substring(k from 7) end end;
  if value is null or btrim(value)='' then return null; end if;
  result:=replace(result,'{{'||m[1]||'}}',value);
 end loop;
 if result like '%{{%' or result like '%}}%' or length(result)>4000 then return null; end if;
 return result;
end $$;

create function koi_private.campaign_candidates(p_id uuid) returns table(lead_id uuid,phone text,name text,message text,reason text)
language sql stable set search_path='' as $$
 select l.id,l.phone,l.name,coalesce(koi_private.render_message(c.template,to_jsonb(l)),''),
 case when exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone=l.phone) then 'suppressed'
 when l.consent<>'granted' then 'consent_required'
 when koi_private.render_message(c.template,to_jsonb(l)) is null then 'missing_variable' end
 from public.koi_campaigns c join public.koi_lead_list_members m on m.workspace_id=c.workspace_id and m.list_id=c.list_id
 join public.koi_leads l on l.workspace_id=m.workspace_id and l.id=m.lead_id
 where c.id=p_id and (cardinality(c.selection)=0 or l.id=any(c.selection)) order by l.phone
$$;

create function koi_private.campaign_window(p_config jsonb,p_now timestamptz) returns timestamptz language plpgsql stable set search_path='' as $$
declare d date; n integer; start_at timestamptz; end_at timestamptz; base timestamptz:=greatest(p_now,coalesce((p_config->>'startsAt')::timestamptz,p_now));
begin
 for n in 0..7 loop
  d:=(base at time zone 'America/Argentina/Tucuman')::date+n;
  if not (p_config->'days' @> to_jsonb(extract(dow from d)::integer)) then continue; end if;
  start_at:=(d+make_interval(mins=>(p_config->>'startMinute')::integer)) at time zone 'America/Argentina/Tucuman';
  end_at:=(d+make_interval(mins=>(p_config->>'endMinute')::integer)) at time zone 'America/Argentina/Tucuman';
  if base<end_at then return greatest(base,start_at); end if;
 end loop;
 raise exception 'Invalid schedule' using errcode='22023';
end $$;

create function koi_private.campaign_command(p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; actor uuid:=auth.uid(); c public.koi_campaigns; s koi_private.senders; body jsonb; cfg jsonb; cid uuid;
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
  if cardinality(ids)>5000 or exists(select 1 from unnest(ids) i where not exists(select 1 from public.koi_lead_list_members m where m.workspace_id=w and m.list_id=(p_data->>'listId')::uuid and m.lead_id=i)) then raise exception 'Invalid recipients' using errcode='22023'; end if;
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
  if total>5000 or eligible=0 then raise exception 'No eligible recipients or too many' using errcode='22023'; end if;
  insert into public.koi_campaign_recipients(workspace_id,campaign_id,lead_id,phone,name,message,status,reason,next_attempt_at)
   select w,c.id,lead_id,phone,name,message,case when reason is null then 'queued' else 'skipped' end,reason,koi_private.campaign_window(c.config,now()) from jsonb_to_recordset(candidates) as q(lead_id uuid,phone text,name text,message text,reason text);
  update public.koi_campaigns set status='scheduled',start_key=(p_data->>'key')::uuid,revision=revision+1,updated_at=now() where id=c.id returning * into c;
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

create function public.koi_campaign_command(p_action text,p_data jsonb) returns jsonb language sql security invoker set search_path='' as $$ select koi_private.campaign_command(p_action,p_data) $$;

create function koi_private.worker_command(p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid; kind text; s koi_private.senders; c public.koi_campaigns; r public.koi_campaign_recipients; old public.koi_campaign_recipients;
 event_row record; n integer; cap integer; next_at timestamptz; boundary timestamptz; status_name text;
begin
 select b.workspace_id,b.kind into w,kind from koi_private.machine_bindings b where b.role_name=session_user;
 if w is null then raise exception 'Unbound machine' using errcode='42501'; end if;
 select * into s from koi_private.senders where workspace_id=w for update;
 if p_action='ingest' then
  if kind<>'webhook' or (p_data->>'instance') is distinct from s.instance then raise exception 'Invalid webhook' using errcode='42501'; end if;
  insert into koi_private.evolution_events(workspace_id,event_key,payload) values(w,p_data->>'eventKey',p_data) on conflict do nothing;
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

grant koi_campaign_owner to postgres;
grant create on schema public,koi_private to koi_campaign_owner;
-- Propietario sin LOGIN/BYPASSRLS y grants explícitos. Ninguna función de máquina en el API público.
alter function koi_private.render_message(text,jsonb) owner to koi_campaign_owner;
alter function koi_private.campaign_candidates(uuid) owner to koi_campaign_owner;
alter function koi_private.campaign_window(jsonb,timestamptz) owner to koi_campaign_owner;
alter function koi_private.campaign_command(text,jsonb) owner to koi_campaign_owner;
alter function koi_private.worker_command(text,jsonb) owner to koi_campaign_owner;
revoke create on schema public,koi_private from koi_campaign_owner;
revoke all on function koi_private.render_message(text,jsonb),koi_private.campaign_candidates(uuid),koi_private.campaign_window(jsonb,timestamptz),koi_private.campaign_command(text,jsonb),koi_private.worker_command(text,jsonb),public.koi_campaign_command(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.campaign_command(text,jsonb),public.koi_campaign_command(text,jsonb) to authenticated;
grant execute on function koi_private.worker_command(text,jsonb) to koi_campaign_worker,koi_campaign_webhook;
commit;
