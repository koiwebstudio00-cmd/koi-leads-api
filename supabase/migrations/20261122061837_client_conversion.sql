begin;
create table koi_private.clients (
 workspace_id uuid references public.koi_workspaces, id uuid default gen_random_uuid(),
 name text not null check(length(trim(name)) between 1 and 200),
 status text not null default 'active' check(status in ('lead','active','paused','closed')),
 assigned_to uuid, revision int not null default 0, source text, source_id uuid, source_author uuid,
 contact_name text, email text, phone text, created_at timestamptz not null default now(),
 primary key(workspace_id,id), unique(workspace_id,source,source_id),
 foreign key(workspace_id,assigned_to) references public.koi_workspace_members
);
create table koi_private.client_contacts (
 workspace_id uuid, lead_id uuid, client_id uuid not null,
 actor uuid not null references auth.users, converted_at timestamptz not null default now(),
 primary key(workspace_id,lead_id), foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id),
 foreign key(workspace_id,client_id) references koi_private.clients
);
create index client_contacts_by_client on koi_private.client_contacts(workspace_id,client_id);
create table koi_private.client_projects (
 workspace_id uuid, client_id uuid, project_id uuid, actor uuid references auth.users, created_at timestamptz not null default now(),
 primary key(workspace_id,client_id,project_id), foreign key(workspace_id,client_id) references koi_private.clients,
 foreign key(workspace_id,project_id) references koi_private.studio_projects
);
create index client_projects_by_project on koi_private.client_projects(workspace_id,project_id);
alter table koi_private.clients enable row level security;
alter table koi_private.client_contacts enable row level security;
alter table koi_private.client_projects enable row level security;
revoke all on koi_private.clients,koi_private.client_projects,koi_private.client_contacts from public,anon,authenticated;

create function koi_private.client_command(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor_id uuid:=auth.uid(); w uuid; cid uuid:=(p->>'clientId')::uuid;
 pid uuid:=(p->>'projectId')::uuid; lid uuid:=(p->>'leadId')::uuid;
 request_key uuid:=(p->>'key')::uuid; prior koi_private.project_events;
 customer koi_private.clients; lead public.koi_leads; linked uuid; result jsonb;
begin
 select workspace_id into strict w from public.koi_workspace_members where user_id=actor_id;
 if action='list' then
  return (select coalesce(jsonb_agg(to_jsonb(c) order by lower(c.name),c.id),'[]') from koi_private.clients c where c.workspace_id=w);
 elsif action='summary' then
  return (select jsonb_build_object('value',count(*)) from koi_private.clients where workspace_id=w and status='active');
 elsif action='projectClients' then
  return (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name),'[]')
   from koi_private.client_projects cp join koi_private.clients c on c.workspace_id=cp.workspace_id and c.id=cp.client_id where cp.workspace_id=w and cp.project_id=pid);
 end if;
 if action in ('convert','edit','contract') then
  if request_key is null then raise exception 'Request key required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(w::text||actor_id::text||request_key::text,0));
  select * into prior from koi_private.project_events where workspace_id=w and actor=actor_id and request_id=request_key;
  if found then
   if prior.action='client:'||action and prior.payload=p then return prior.result; end if;
   raise exception 'Request changed' using errcode='PT409';
  end if;
 end if;
 if action in ('lead','convert') then
  if action='convert' then
   select * into lead from public.koi_leads where workspace_id=w and id=lid and deleted_at is null for update;
  else
   select * into lead from public.koi_leads where workspace_id=w and id=lid and deleted_at is null;
  end if;
  if not found then raise exception 'Lead missing' using errcode='PT404'; end if;
  select client_id into linked from koi_private.client_contacts where workspace_id=w and lead_id=lid;
  if action='lead' then
   return jsonb_build_object('clientId',linked,'contractedProjects',(select coalesce(jsonb_agg(cp.project_id),'[]') from koi_private.client_projects cp where cp.workspace_id=w and cp.client_id=linked),'conversion',(select jsonb_build_object('actor',coalesce(nullif(to_jsonb(u)->>'email',''),'Miembro '||left(u.id::text,8)),'at',cc.converted_at,'name',c.name)
    from koi_private.client_contacts cc join auth.users u on u.id=cc.actor join koi_private.clients c on c.workspace_id=w and c.id=cc.client_id
    where cc.workspace_id=w and cc.lead_id=lid));
  end if;
  if linked is not null then raise exception 'Already converted' using errcode='PT409'; end if;
  if cid is null then
   insert into koi_private.clients(workspace_id,name,assigned_to,contact_name,email,phone) values(w,trim(p->>'name'),lead.assigned_to,lead.name,lead.email,lead.phone) returning id into cid;
  end if;
 end if;
 select * into customer from koi_private.clients where workspace_id=w and id=cid;
 if not found then raise exception 'Client missing' using errcode='PT404'; end if;
 case action
 when 'detail' then
  return jsonb_build_object('client',to_jsonb(customer),'contacts',(select coalesce(jsonb_agg(jsonb_build_object(
   'id',l.id,'name',l.name,'phone',l.phone,'actor',coalesce(nullif(to_jsonb(u)->>'email',''),'Miembro '||left(u.id::text,8)),'converted_at',cc.converted_at) order by cc.converted_at),'[]')
   from koi_private.client_contacts cc join public.koi_leads l on l.workspace_id=w and l.id=cc.lead_id
   join auth.users u on u.id=cc.actor where cc.workspace_id=w and cc.client_id=cid and l.deleted_at is null),
   'projects',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name),'[]')
    from koi_private.client_projects cp join koi_private.studio_projects s on s.workspace_id=w and s.id=cp.project_id
    where cp.workspace_id=w and cp.client_id=cid));
 when 'convert' then
  insert into koi_private.client_contacts(workspace_id,lead_id,client_id,actor) values(w,lid,cid,actor_id);
 when 'edit' then
  update koi_private.clients set assigned_to=(p->>'assigned_to')::uuid,status=p->>'status',revision=revision+1
   where workspace_id=w and id=cid and revision=(p->>'revision')::int;
  if not found then raise exception 'Client changed' using errcode='PT409'; end if;
 when 'contract' then
  if pid is null then raise exception 'Project required' using errcode='22023'; end if;
 else raise exception 'Unknown operation' using errcode='22023';
 end case;
 if pid is not null and action in ('contract','convert') then
  insert into koi_private.client_projects(workspace_id,client_id,project_id,actor) values(w,cid,pid,actor_id) on conflict do nothing;
 end if;
 result:=jsonb_build_object('clientId',cid);
 insert into koi_private.project_events(workspace_id,actor,request_id,action,payload,result)
 values(w,actor_id,request_key,'client:'||action,p,result);
 return result;
exception when no_data_found then raise exception 'Membership required' using errcode='42501';
end $$;
create function public.koi_client_command(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$select koi_private.client_command(action,p)$$;
revoke all on function public.koi_client_command(text,jsonb),koi_private.client_command(text,jsonb) from public,anon;
grant execute on function public.koi_client_command(text,jsonb),koi_private.client_command(text,jsonb) to authenticated;
commit;
