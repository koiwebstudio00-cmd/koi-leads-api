begin;
-- Leer el sub del contexto JWT validado por PostgREST, sin depender de USAGE en auth.
-- El rol propietario sigue sin LOGIN/BYPASSRLS; se exige membresía en cada operación.
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


commit;
