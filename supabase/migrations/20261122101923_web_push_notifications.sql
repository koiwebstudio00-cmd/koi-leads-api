begin;
create table koi_private.push_devices (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null, user_id uuid not null, endpoint text not null unique,
 p256dh text not null, auth_key text not null,
 foreign key(workspace_id,user_id) references public.koi_workspace_members on delete cascade
);
create index push_device_member on koi_private.push_devices(workspace_id,user_id);
create table koi_private.push_jobs (
 id uuid primary key default gen_random_uuid(), device_id uuid not null references koi_private.push_devices on delete cascade,
 event_key text not null, title text not null, body text not null, path text not null,
 expires_at timestamptz not null, available_at timestamptz default now(), lease uuid, attempts int not null default 0,
 unique(device_id,event_key)
);
create index push_pending on koi_private.push_jobs(available_at) where available_at is not null;
create index push_expiry on koi_private.push_jobs(expires_at);
alter table koi_private.push_devices enable row level security;
alter table koi_private.push_jobs enable row level security;
revoke all on koi_private.push_devices,koi_private.push_jobs from public,anon,authenticated;

-- Called by the authenticated API with the membership resolved from the session.
create function koi_private.push_device(action text,w uuid,u uuid,p jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if action='remove' then
  delete from koi_private.push_devices where workspace_id=w and user_id=u and endpoint=p->>'endpoint';
  return true;
 elsif action='status' then
  return exists(select from koi_private.push_devices where workspace_id=w and user_id=u and endpoint=p->>'endpoint');
 elsif action='save' then
  insert into koi_private.push_devices(workspace_id,user_id,endpoint,p256dh,auth_key)
    values(w,u,p->>'endpoint',p->'keys'->>'p256dh',p->'keys'->>'auth')
    on conflict(endpoint) do update set p256dh=excluded.p256dh,auth_key=excluded.auth_key
    where push_devices.workspace_id=w and push_devices.user_id=u;
  return found;
 end if;
 raise exception 'Unknown action';
end $$;

create function koi_private.push_incoming() returns trigger language plpgsql security definer set search_path='' as $$
declare channel_label text; destination text; sender text; preview text;
begin
 if not exists(select from koi_private.push_devices where workspace_id=new.workspace_id) then return new; end if;
 if tg_table_name='chat_messages' then
  select c.instance||' . evo',coalesce(nullif(trim(c.name),''),nullif(trim(l.name),''),c.phone)
    into channel_label,sender from public.koi_conversations c
    left join public.koi_leads l on l.workspace_id=c.workspace_id and l.id=c.lead_id
    where c.id=new.conversation_id and c.workspace_id=new.workspace_id;
  destination:='/conversaciones/';
 else
  select case c.channel when 'instagram' then 'IG' else 'WP' end,
    coalesce(nullif(trim(l.name),''),nullif(trim(i.display_name),''),nullif(trim(i.username),''),l.phone)
    into channel_label,sender from public.koi_inbox_conversations c
    join koi_private.inbox_identities i on i.workspace_id=c.workspace_id and i.id=c.identity_id
    join public.koi_leads l on l.workspace_id=c.workspace_id and l.id=c.lead_id
    where c.workspace_id=new.workspace_id and c.id=new.conversation_id;
  destination:='/inbox/';
 end if;
 preview:=trim(regexp_replace(new.body,'[[:space:]]+',' ','g'));
 if preview='' then
  preview:='Mensaje sin texto';
  if tg_table_name='chat_messages' then
   if new.attachment_name is not null or new.attachment_mime is not null then preview:='Adjunto'; end if;
  elsif jsonb_array_length(new.provider_attachments)>0 then preview:='Adjunto';
  end if;
 elsif char_length(preview)>120 then
  preview:=rtrim(left(preview,117))||'...';
 end if;
 insert into koi_private.push_jobs(device_id,event_key,title,body,path,expires_at)
 select id,tg_table_name||':'||new.id,left(coalesce(sender,'Contacto'),100)||' · '||channel_label,preview,
   destination||new.conversation_id,now()+interval '1 hour'
 from koi_private.push_devices where workspace_id=new.workspace_id on conflict do nothing;
 return new;
end $$;
create trigger push_evolution after insert on koi_private.chat_messages for each row
 when(new.direction='in' and not new.historical and new.status='received') execute function koi_private.push_incoming();
create trigger push_zernio after insert on koi_private.inbox_messages for each row
 when(new.direction='in' and not new.historical and new.status='received') execute function koi_private.push_incoming();

-- A webhook can reconcile a message already inserted by the Zernio history sync.
create trigger push_zernio_reconciled after update of historical on koi_private.inbox_messages for each row
 when(old.historical and not new.historical and new.direction='in' and new.status='received')
 execute function koi_private.push_incoming();

-- Date-only project tasks expire the following day. Follow-ups have an exact deadline.
create function koi_private.push_due(at_time timestamptz) returns table(workspace_id uuid,recipient uuid,event_key text,title text,body text,path text)
language sql stable set search_path='' as $$
 with clock as (select at_time at time zone 'America/Argentina/Tucuman' local_time),
 tasks as (
  select t.workspace_id,coalesce(l.assigned_to,t.created_by) recipient,t.id,t.title,
    (t.due_at at time zone 'America/Argentina/Tucuman')::date due,t.due_at<=at_time overdue,'/seguimientos?task=' path
  from public.koi_followups t join public.koi_leads l on l.workspace_id=t.workspace_id and l.id=t.lead_id
  where t.status='pending' and l.deleted_at is null and t.due_at is not null
  union all select i.workspace_id,null::uuid,i.id,i.title,i.due_date,i.due_date<c.local_time::date,'/entregas/'
  from koi_private.delivery_items i cross join clock c where i.kind='task' and i.status<>'done' and i.due_date is not null
 )
 select t.workspace_id,t.recipient,'task:'||t.path||t.id||':'||c.local_time::date||':'||t.overdue,
   case when t.overdue then 'Tarea vencida' else 'Tarea para hoy' end,left(t.title,160),t.path||t.id
 from tasks t cross join clock c where t.due<=c.local_time::date and c.local_time::time>=time '09:00'
$$;
create function koi_private.push_schedule() returns void language plpgsql security definer set search_path='' as $$
begin
 delete from koi_private.push_jobs where expires_at<=now();
 insert into koi_private.push_jobs(device_id,event_key,title,body,path,expires_at)
 select d.id,t.event_key,t.title,t.body,t.path,((now() at time zone 'America/Argentina/Tucuman')::date+1)::timestamp at time zone 'America/Argentina/Tucuman'
 from koi_private.push_due(now()) t join koi_private.push_devices d on d.workspace_id=t.workspace_id
 and (t.recipient is null or d.user_id=t.recipient) on conflict do nothing;
end $$;

create function koi_private.push_claim() returns table(id uuid,lease uuid,recipient uuid,endpoint text,p256dh text,auth_key text,title text,body text,path text,event_key text,ttl int)
language sql security definer set search_path='' as $$
 with batch as (
  select j.id from koi_private.push_jobs j join koi_private.push_devices d on d.id=j.device_id
  where j.available_at<=now() and j.expires_at>now() and (j.event_key not like 'task:%' or exists(
   select from koi_private.push_due(now()) t where t.workspace_id=d.workspace_id and (t.recipient is null or t.recipient=d.user_id) and t.event_key=j.event_key))
  order by j.available_at,j.id limit 12 for update of j skip locked
 ), claimed as (
  update koi_private.push_jobs j set lease=gen_random_uuid(),available_at=now()+interval '2 minutes',attempts=attempts+1
   from batch where j.id=batch.id returning j.*
 )
 select j.id,j.lease,d.user_id,d.endpoint,d.p256dh,d.auth_key,j.title,j.body,j.path,j.event_key,
  greatest(1,floor(extract(epoch from j.expires_at-now()))::int)
 from claimed j join koi_private.push_devices d on d.id=j.device_id
$$;
create function koi_private.push_finish(job uuid,claim uuid,outcome text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if outcome='expired' then
  delete from koi_private.push_devices where id=(select device_id from koi_private.push_jobs where id=job and lease=claim);
 else
  update koi_private.push_jobs set lease=null,available_at=case when outcome='retry' then now()+least(900,5*power(2,least(attempts,8))) * interval '1 second' end
   where id=job and lease=claim;
 end if;
end $$;
revoke all on function koi_private.push_device(text,uuid,uuid,jsonb),koi_private.push_incoming(),
 koi_private.push_due(timestamptz),koi_private.push_schedule(),koi_private.push_claim(),koi_private.push_finish(uuid,uuid,text)
 from public,anon,authenticated;
commit;
