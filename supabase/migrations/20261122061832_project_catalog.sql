begin;
create table koi_private.studio_projects (
  workspace_id uuid not null references public.koi_workspaces(id),
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  type text not null check (length(trim(type)) between 1 and 80),
  ownership text not null check (ownership in ('client','studio','saas')),
  status text not null check (status in ('active','paused','done')),
  start_date date, deadline date,
  revision integer not null default 0,
  source text, source_project_id uuid, source_client_id uuid, source_client_label text, source_author_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(workspace_id,id), unique(workspace_id,source,source_project_id),
  check (deadline >= start_date)
);
create index studio_projects_name on koi_private.studio_projects(workspace_id,lower(name),id);
create table koi_private.project_interests (
  workspace_id uuid not null, project_id uuid not null, lead_id uuid not null,
  reason text not null check(length(trim(reason)) between 1 and 500),
  assigned_to uuid not null, revision uuid not null default gen_random_uuid(),
  primary key(workspace_id,lead_id,project_id),
  foreign key(workspace_id,project_id) references koi_private.studio_projects,
  foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id),
  foreign key(workspace_id,assigned_to) references public.koi_workspace_members
);
create index project_interests_project on koi_private.project_interests(workspace_id,project_id);
create table koi_private.project_events (
  workspace_id uuid not null, actor uuid not null references auth.users(id),
  request_id uuid not null, action text not null, payload jsonb not null, result jsonb not null,
  previous jsonb, occurred_at timestamptz not null default now(),
  primary key(workspace_id,actor,request_id)
);
alter table koi_private.studio_projects enable row level security;
alter table koi_private.project_interests enable row level security;
alter table koi_private.project_events enable row level security;
revoke all on koi_private.studio_projects,koi_private.project_interests,koi_private.project_events from public,authenticated,anon;

create function koi_private.project_command(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor_id uuid := auth.uid();
  w uuid;
  pid uuid := (p->>'projectId')::uuid;
  lid uuid := (p->>'leadId')::uuid;
  request_key uuid := (p->>'key')::uuid;
  project koi_private.studio_projects;
  interest koi_private.project_interests;
  prior koi_private.project_events;
  previous jsonb;
  result jsonb;
begin
  select workspace_id into w from public.koi_workspace_members where user_id=actor_id;
  if w is null then raise exception 'Membership required' using errcode='42501'; end if;
  if action='list' then
    return (select coalesce(jsonb_agg(to_jsonb(s) order by lower(s.name),s.id),'[]') from koi_private.studio_projects s
      where s.workspace_id=w and strpos(lower(s.name),lower(coalesce(p->>'search','')))>0);
  end if;
  if action in ('create','edit','associate','correct','remove') then
    if request_key is null then raise exception 'Request key required' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended(w::text||actor_id::text||request_key::text,0));
    select * into prior from koi_private.project_events where workspace_id=w and actor=actor_id and request_id=request_key;
    if found then
      if prior.action=action and prior.payload=p then return prior.result; end if;
      raise exception 'Request key conflict' using errcode='PT409';
    end if;
  end if;
  if action in ('detail','edit','associate','correct','remove') then
    select * into project from koi_private.studio_projects where workspace_id=w and id=pid;
    if not found then raise exception 'Project missing' using errcode='PT404'; end if;
  end if;
  if action in ('interests','associate','correct','remove') then
    perform 1 from public.koi_leads where workspace_id=w and id=lid and deleted_at is null for share;
    if not found then raise exception 'Lead missing' using errcode='PT404'; end if;
  end if;
  case action
  when 'detail' then
    return jsonb_build_object('project',to_jsonb(project),'leads',(select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('name',coalesce(nullif(l.name,''),l.phone,'Sin nombre')) order by l.name,l.id),'[]')
      from koi_private.project_interests i join public.koi_leads l on l.workspace_id=i.workspace_id and l.id=i.lead_id
      where i.workspace_id=w and i.project_id=pid and l.deleted_at is null));
  when 'interests' then
    return (select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('name',s.name) order by lower(s.name),s.id),'[]')
      from koi_private.project_interests i join koi_private.studio_projects s on s.workspace_id=i.workspace_id and s.id=i.project_id
      where i.workspace_id=w and i.lead_id=lid);
  when 'create' then
    insert into koi_private.studio_projects(workspace_id,name,type,ownership,status,start_date,deadline)
      values(w,trim(p->>'name'),trim(p->>'type'),p->>'ownership',p->>'status',(p->>'start_date')::date,(p->>'deadline')::date) returning * into project;
    result:=to_jsonb(project);
  when 'edit' then
    previous:=to_jsonb(project);
    update koi_private.studio_projects set name=trim(p->>'name'),type=trim(p->>'type'),ownership=p->>'ownership',status=p->>'status',
      start_date=(p->>'start_date')::date,deadline=(p->>'deadline')::date,updated_at=now(),revision=revision+1
      where workspace_id=w and id=pid and revision=(p->>'revision')::int returning * into project;
    if not found then raise exception 'Project changed' using errcode='PT409'; end if;
    result:=to_jsonb(project);
  when 'associate' then
    insert into koi_private.project_interests(workspace_id,project_id,lead_id,assigned_to,reason)
      values(w,pid,lid,(p->>'assigned_to')::uuid,trim(p->>'reason')) returning * into interest;
    result:=to_jsonb(interest);
  when 'correct','remove' then
    select * into interest from koi_private.project_interests
      where workspace_id=w and project_id=pid and lead_id=lid and revision=(p->>'revision')::uuid for update;
    if not found then raise exception 'Interest changed' using errcode='PT409'; end if;
    previous:=to_jsonb(interest);
    if action='remove' then
      delete from koi_private.project_interests where workspace_id=w and project_id=pid and lead_id=lid;
      result:='{}';
    else
      update koi_private.project_interests set reason=trim(p->>'reason'),assigned_to=(p->>'assigned_to')::uuid,revision=gen_random_uuid()
        where workspace_id=w and project_id=pid and lead_id=lid returning * into interest;
      result:=to_jsonb(interest);
    end if;
  else raise exception 'Unknown operation' using errcode='22023';
  end case;
  insert into koi_private.project_events(workspace_id,actor,request_id,action,payload,previous,result)
    values(w,actor_id,request_key,action,p,previous,result);
  return result;
end $$;
create function public.koi_project_command(action text,p jsonb) returns jsonb
language sql security invoker set search_path='' as $$select koi_private.project_command(action,p)$$;
revoke all on function koi_private.project_command(text,jsonb),public.koi_project_command(text,jsonb) from public,anon;
grant execute on function koi_private.project_command(text,jsonb),public.koi_project_command(text,jsonb) to authenticated;
commit;
