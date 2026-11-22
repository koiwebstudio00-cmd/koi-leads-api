begin;
create table koi_private.delivery_items (
 workspace_id uuid references public.koi_workspaces, id uuid default gen_random_uuid(),
 kind text not null, title text not null check(length(trim(title)) between 1 and 240),
 body text not null default '', status text not null, due_date date, starts_at timestamptz, ends_at timestamptz, location text,
 project_id uuid, client_id uuid, improvement_id uuid, position integer not null default 0,
 author uuid not null, source_id uuid, source text, revision int not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(workspace_id,id), unique(workspace_id,source,kind,source_id), unique(workspace_id,improvement_id),
 foreign key(workspace_id,project_id) references koi_private.studio_projects,
 foreign key(workspace_id,client_id) references koi_private.clients,
 foreign key(workspace_id,improvement_id) references koi_private.delivery_items,
 check (case kind when 'task' then project_id is not null and status in ('todo','doing','review','done')
  when 'milestone' then project_id is not null and due_date is not null and status in ('todo','done')
  when 'meeting' then starts_at is not null and project_id is null and status='scheduled'
  when 'note' then status='internal' when 'improvement' then status in ('proposed','accepted','in_progress','done','rejected') else false end),
 constraint delivery_typed_fields check (
   length(body)<=16000 and (location is null or length(location)<=2000)
   and (kind in ('task','milestone') or due_date is null)
   and (kind='meeting' or (starts_at is null and ends_at is null and location is null))
 ),
 check(ends_at is null or ends_at>=starts_at)
);
create index delivery_project on koi_private.delivery_items(workspace_id,project_id);
create index delivery_client on koi_private.delivery_items(workspace_id,client_id);
create table koi_private.delivery_meeting_projects (
 workspace_id uuid, item_id uuid, project_id uuid, primary key(workspace_id,item_id,project_id),
 foreign key(workspace_id,item_id) references koi_private.delivery_items,
 foreign key(workspace_id,project_id) references koi_private.studio_projects
);
create table koi_private.delivery_comments (
 workspace_id uuid, id uuid default gen_random_uuid(), item_id uuid not null, body text not null check(length(trim(body)) between 1 and 4000),
 author uuid not null, created_at timestamptz not null default now(), primary key(workspace_id,id),
 foreign key(workspace_id,item_id) references koi_private.delivery_items
);
create table koi_private.delivery_files (
 workspace_id uuid references public.koi_workspaces, id uuid default gen_random_uuid(), project_id uuid, client_id uuid,
 name text not null check(length(trim(name)) between 1 and 255), content bytea not null check(octet_length(content) between 1 and 5242880),
 digest text generated always as (encode(sha256(content),'hex')) stored,
 author uuid not null, created_at timestamptz not null default now(), primary key(workspace_id,id),
 foreign key(workspace_id,project_id) references koi_private.studio_projects,
 foreign key(workspace_id,client_id) references koi_private.clients,
 foreign key(workspace_id,client_id,project_id) references koi_private.client_projects
);
alter table koi_private.delivery_items enable row level security;
alter table koi_private.delivery_comments enable row level security;
alter table koi_private.delivery_files enable row level security;
alter table koi_private.delivery_meeting_projects enable row level security;
revoke all on koi_private.delivery_items,koi_private.delivery_comments,koi_private.delivery_files,koi_private.delivery_meeting_projects from public,anon,authenticated;

-- Files have three internal browsing contexts. A client view also includes common
-- product files for its contracts. Only team members can call the enclosing RPC.
create function koi_private.delivery_file_visible(w uuid,c uuid,p uuid,fc uuid,fp uuid)
returns boolean language sql stable security invoker set search_path='' as $$
 select case when c is not null then
   (fc=c and (p is null or fp=p)) or (fc is null and fp is not null and (p is null or fp=p) and exists
    (select 1 from koi_private.client_projects where workspace_id=w and client_id=c and project_id=fp))
  when p is not null then fp=p and fc is null else fc is null and fp is null end
$$;
revoke all on function koi_private.delivery_file_visible(uuid,uuid,uuid,uuid,uuid) from public,authenticated,anon;

create function koi_private.delivery_command(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 a uuid:=auth.uid(); w uuid; cid uuid:=(p->>'clientId')::uuid; pid uuid:=(p->>'projectId')::uuid;
 item uuid:=(p->>'id')::uuid; req uuid:=(p->>'key')::uuid; row_item koi_private.delivery_items;
 prev koi_private.project_events; signature jsonb; result jsonb; target uuid; meeting_project uuid;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=a;
 if w is null then raise exception 'Membership required' using errcode='42501'; end if;
 if action='list' then
  return (select coalesce(jsonb_agg(to_jsonb(i) order by i.due_date nulls last,i.position,i.created_at,i.id),'[]')
   from koi_private.delivery_items i where i.workspace_id=w
   and (pid is null or i.project_id=pid or exists(select 1 from koi_private.delivery_meeting_projects m where m.workspace_id=w and m.item_id=i.id and m.project_id=pid))
   and (cid is null or i.client_id=cid or (i.client_id is null and exists(select 1 from koi_private.client_projects cp where cp.workspace_id=w and cp.client_id=cid
   and (cp.project_id=i.project_id or exists(select 1 from koi_private.delivery_meeting_projects m where m.workspace_id=w and m.item_id=i.id and m.project_id=cp.project_id))))));
 elsif action='followup' then
  select to_jsonb(f)||jsonb_build_object('lead_name',l.name,'phone',l.phone,'assigned_to',l.assigned_to) into result
   from public.koi_followups f join public.koi_leads l on l.workspace_id=f.workspace_id and l.id=f.lead_id
   where f.workspace_id=w and f.id=item and l.deleted_at is null;
  if result is null then raise exception 'Followup missing' using errcode='PT404'; end if;
  return result;
 elsif action='agenda' then
  return (select coalesce(jsonb_agg(to_jsonb(e) order by e.at,e.id),'[]') from (
   select i.id,i.kind,i.title,coalesce(i.starts_at,i.due_date::timestamp at time zone 'America/Argentina/Tucuman') at, i.due_date,null::uuid lead_id
   from koi_private.delivery_items i where i.workspace_id=w and (i.starts_at is not null or i.due_date is not null) and i.status<>'done'
   union all select f.id,'followup',f.title,f.due_at,null,f.lead_id from public.koi_followups f join public.koi_leads l on l.workspace_id=f.workspace_id and l.id=f.lead_id
   where f.workspace_id=w and f.status='pending' and f.due_at is not null and l.deleted_at is null) e);
 elsif action='files' then
  return (select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'digest',f.digest,'size',octet_length(f.content),'client_id',f.client_id,'project_id',f.project_id) order by f.created_at desc),'[]')
   from koi_private.delivery_files f where f.workspace_id=w and koi_private.delivery_file_visible(w,cid,pid,f.client_id,f.project_id));
 elsif action='download' then
  select jsonb_build_object('name',f.name,'content',encode(f.content,'base64'),'digest',f.digest) into result from koi_private.delivery_files f
   where f.workspace_id=w and f.id=item and koi_private.delivery_file_visible(w,cid,pid,f.client_id,f.project_id);
  if result is null then raise exception 'File missing' using errcode='PT404'; end if;
  return result;
 end if;
 if action<>'detail' then
  if req is null then raise exception 'Request key required' using errcode='22023'; end if;
  signature:=to_jsonb(encode(sha256(convert_to(p::text,'UTF8')),'hex'));
  perform pg_advisory_xact_lock(hashtextextended(w::text||a::text||req::text,0));
  select * into prev from koi_private.project_events where workspace_id=w and actor=a and request_id=req;
  if found then
   if prev.action='delivery:'||action and prev.payload=signature then return prev.result; end if;
   raise exception 'Request conflict' using errcode='PT409';
  end if;
 end if;
 if action in ('detail','edit','convert','comment') then
  if action='detail' then
   select * into row_item from koi_private.delivery_items where workspace_id=w and id=item;
  else
   select * into row_item from koi_private.delivery_items where workspace_id=w and id=item for update;
  end if;
  if not found then raise exception 'Item missing' using errcode='PT404'; end if;
 end if;
 case action
 when 'detail' then
  return to_jsonb(row_item)||jsonb_build_object('projects',(select coalesce(jsonb_agg(m.project_id),'[]') from koi_private.delivery_meeting_projects m where m.workspace_id=w and m.item_id=item),
   'comments',(select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at,c.id),'[]') from koi_private.delivery_comments c where c.workspace_id=w and c.item_id=item),
   'taskId',(select id from koi_private.delivery_items where workspace_id=w and improvement_id=item));
 when 'create','edit' then
  if cid is not null and pid is not null and not exists(select 1 from koi_private.client_projects where workspace_id=w and project_id=pid and client_id=cid)
   then raise exception 'Project not contracted' using errcode='22023'; end if;
  if action='create' then
   insert into koi_private.delivery_items(workspace_id,kind,title,body,status,due_date,starts_at,ends_at,location,client_id,project_id,author)
    values(w,p->>'kind',trim(p->>'title'),coalesce(p->>'body',''),p->>'status',(p->>'due_date')::date,(p->>'starts_at')::timestamptz,
    (p->>'ends_at')::timestamptz,p->>'location',cid,pid,a) returning id into item;
  else
   update koi_private.delivery_items set title=trim(p->>'title'),body=coalesce(p->>'body',''),status=p->>'status',due_date=(p->>'due_date')::date,
    starts_at=(p->>'starts_at')::timestamptz,ends_at=(p->>'ends_at')::timestamptz,location=p->>'location',revision=revision+1,updated_at=now()
    where workspace_id=w and id=item and revision=(p->>'revision')::int and kind=p->>'kind' and project_id is not distinct from pid and client_id is not distinct from cid;
   if not found then raise exception 'Item changed' using errcode='PT409'; end if;
   delete from koi_private.delivery_meeting_projects where workspace_id=w and item_id=item;
  end if;
  for meeting_project in select value::uuid from jsonb_array_elements_text(p->'projects') loop
   if p->>'kind'<>'meeting' or (cid is not null and not exists(select 1 from koi_private.client_projects where workspace_id=w and client_id=cid and project_id=meeting_project))
    then raise exception 'Invalid meeting project' using errcode='22023'; end if;
   insert into koi_private.delivery_meeting_projects values(w,item,meeting_project);
  end loop;
 when 'convert' then
  select id into target from koi_private.delivery_items where workspace_id=w and improvement_id=item;
  if target is null then
   if row_item.kind<>'improvement' or row_item.status<>'accepted' then raise exception 'Accepted improvement required' using errcode='PT409'; end if;
   if row_item.project_id is not null and row_item.project_id<>pid then raise exception 'Project mismatch' using errcode='22023'; end if;
   if row_item.client_id is not null and not exists(select 1 from koi_private.client_projects where workspace_id=w and project_id=pid and client_id=row_item.client_id) then raise exception 'Project not contracted' using errcode='22023'; end if;
   insert into koi_private.delivery_items(workspace_id,project_id,client_id,kind,title,body,status,author,improvement_id)
    values(w,pid,row_item.client_id,'task',row_item.title,row_item.body,'todo',a,item) returning id into target;
   update koi_private.delivery_items set status='in_progress',revision=revision+1,updated_at=now() where workspace_id=w and id=item;
  end if;
  item:=target;
 when 'comment' then
  if row_item.kind<>'improvement' then raise exception 'Improvement required' using errcode='22023'; end if;
  insert into koi_private.delivery_comments(workspace_id,item_id,body,author) values(w,item,trim(p->>'body'),a);
 when 'upload' then
  insert into koi_private.delivery_files(workspace_id,project_id,client_id,name,content,author)
   values(w,pid,cid,p->>'name',decode(p->>'content','base64'),a) returning id into item;
 else raise exception 'Unknown delivery action' using errcode='22023';
 end case;
 result:=jsonb_build_object('id',item);
 insert into koi_private.project_events(workspace_id,actor,request_id,action,payload,result) values(w,a,req,'delivery:'||action,signature,result);
 return result;
end $$;
create function public.koi_delivery_command(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$select koi_private.delivery_command(action,p)$$;
revoke all on function koi_private.delivery_command(text,jsonb),public.koi_delivery_command(text,jsonb) from public,anon;
grant execute on function koi_private.delivery_command(text,jsonb),public.koi_delivery_command(text,jsonb) to authenticated;
commit;
