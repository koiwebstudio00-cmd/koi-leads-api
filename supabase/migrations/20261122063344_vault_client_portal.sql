begin;
-- The existing bindings identify verified historical Backoffice owners.
alter table koi_private.finance_owners add column vault_access boolean not null default true, add column portal_access boolean not null default true;
create table koi_private.vault_entries(
 workspace_id uuid references public.koi_workspaces,id uuid,kind text not null check(kind in ('credential','env')),
 label text not null check(length(trim(label)) between 1 and 160),client_id uuid,project_id uuid,
 version int not null check(version>0),envelope text not null,revision int not null default 0,
 author uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 source text,source_id uuid,source_key_version int,primary key(workspace_id,id),unique(workspace_id,source,kind,source_id),
 foreign key(workspace_id,client_id) references koi_private.clients,foreign key(workspace_id,project_id) references koi_private.studio_projects,
 foreign key(workspace_id,client_id,project_id) references koi_private.client_projects,
 check(kind<>'env' or project_id is not null)
);
create table koi_private.vault_accesses(
 workspace_id uuid,id uuid default gen_random_uuid(),entry_id uuid not null,actor uuid not null,accessed_at timestamptz not null default now(),
 primary key(workspace_id,id),foreign key(workspace_id,entry_id) references koi_private.vault_entries
);
create table koi_private.client_portals(
 workspace_id uuid,client_id uuid, token_hash text unique check(length(token_hash)=64),revision int not null default 0,
 choices jsonb not null default '[]',changed_by uuid not null,updated_at timestamptz not null default now(),
 primary key(workspace_id,client_id),foreign key(workspace_id,client_id) references koi_private.clients
);
alter table koi_private.vault_entries enable row level security;
alter table koi_private.vault_accesses enable row level security;
alter table koi_private.client_portals enable row level security;
revoke all on koi_private.vault_entries,koi_private.vault_accesses,koi_private.client_portals from public,anon,authenticated;

-- Recompute eligibility on publication and on every read, including file downloads.
create function koi_private.portal_candidates(w uuid,c uuid) returns table(kind text,id uuid,label text) language sql stable set search_path='' as $$
 select 'project',s.id,s.name from koi_private.studio_projects s join koi_private.client_projects cp
 on cp.workspace_id=s.workspace_id and cp.project_id=s.id where s.workspace_id=w and cp.client_id=c
 union all select 'payment',m.id,m.concept from koi_private.finance_movements m where m.workspace_id=w and m.client_id=c and m.type='income'
 union all select 'note',i.id,i.title from koi_private.delivery_items i where i.workspace_id=w and i.kind='note'
 and (i.client_id=c or i.client_id is null and i.project_id is not null)
 and (i.project_id is null or exists(select 1 from koi_private.client_projects cp where cp.workspace_id=w and cp.client_id=c and cp.project_id=i.project_id))
 union all select 'file',f.id,f.name from koi_private.delivery_files f where f.workspace_id=w
 and (f.client_id=c or f.client_id is null and f.project_id is not null)
 and (f.project_id is null or exists(select 1 from koi_private.client_projects cp where cp.workspace_id=w and cp.client_id=c and cp.project_id=f.project_id))
$$;
revoke all on function koi_private.portal_candidates(uuid,uuid) from public,anon,authenticated;
create function koi_private.sensitive_command(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid:=auth.uid();owner_row koi_private.finance_owners;w uuid; eid uuid:=(p->>'id')::uuid;cid uuid:=(p->>'clientId')::uuid;
 entry koi_private.vault_entries; portal koi_private.client_portals; choices jsonb:=p->'choices';
begin
 select * into owner_row from koi_private.finance_owners where user_id=a;
 w:=owner_row.workspace_id;
 if action='access' then return jsonb_build_object('vault',coalesce(owner_row.vault_access,false),'portal',coalesce(owner_row.portal_access,false));end if;
 if action like 'vault_%' and owner_row.vault_access is true then
  case action
  when 'vault_list' then return (select coalesce(jsonb_agg((to_jsonb(v)-'envelope') order by lower(v.label),v.id),'[]') from koi_private.vault_entries v where v.workspace_id=w);
  when 'vault_audit' then return (select coalesce(jsonb_agg(to_jsonb(l) order by l.accessed_at desc),'[]') from koi_private.vault_accesses l where l.workspace_id=w and l.entry_id=eid);
  when 'vault_reveal' then
   select * into entry from koi_private.vault_entries where workspace_id=w and id=eid;
   if not found then raise exception 'Missing entry' using errcode='PT404';end if;
   insert into koi_private.vault_accesses(workspace_id,entry_id,actor) values(w,eid,a);
   return jsonb_build_object('kind',entry.kind,'version',entry.version,'envelope',entry.envelope);
  when 'vault_save' then
   if (p->>'revision')::int=-1 then
    insert into koi_private.vault_entries(workspace_id,id,kind,label,client_id,project_id,author,version,envelope)
    values(w,eid,p->>'kind',p->>'label',cid,(p->>'projectId')::uuid,a,(p->>'version')::int,p->>'envelope') on conflict do nothing;
   else
    update koi_private.vault_entries set label=p->>'label',client_id=cid,project_id=(p->>'projectId')::uuid,
     envelope=p->>'envelope',version=(p->>'version')::int,updated_at=now(),revision=revision+1
     where workspace_id=w and id=eid and revision=(p->>'revision')::int and kind=p->>'kind';
   end if;
   if not found then raise exception 'Entry changed' using errcode='PT409';end if;
   return jsonb_build_object('id',eid);
  else raise exception 'Invalid action' using errcode='22023';
  end case;
 elsif action like 'portal_%' and owner_row.portal_access is true then
  perform 1 from koi_private.clients where workspace_id=w and id=cid for update;
  if not found then raise exception 'Missing client' using errcode='PT404';end if;
  select * into portal from koi_private.client_portals where workspace_id=w and client_id=cid;
  if action='portal_detail' then
   return jsonb_build_object('active',portal.token_hash is not null,'revision',coalesce(portal.revision,0),'choices',coalesce(portal.choices,'[]'),
    'available',(select coalesce(jsonb_agg(to_jsonb(t) order by t.kind,t.label,t.id),'[]') from koi_private.portal_candidates(w,cid) t));
  end if;
  if coalesce(portal.revision,0) is distinct from (p->>'revision')::int then raise exception 'Portal changed' using errcode='PT409';end if;
  if action='portal_publish' then
   if jsonb_typeof(choices) is distinct from 'array' or exists(select 1 from jsonb_array_elements(choices) e where not exists(
    select 1 from koi_private.portal_candidates(w,cid) t where e=jsonb_build_object('kind',t.kind,'id',t.id))) then raise exception 'Invalid selection' using errcode='22023';end if;
  elsif action='portal_rotate' then
   if coalesce(p->>'hash','') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid hash' using errcode='22023';end if;
  elsif action<>'portal_revoke' then raise exception 'Invalid action' using errcode='22023';
  end if;
  insert into koi_private.client_portals(workspace_id,client_id,token_hash,choices,revision,changed_by)
  values(w,cid,case action when 'portal_rotate' then p->>'hash' when 'portal_publish' then portal.token_hash end,
   case action when 'portal_publish' then choices else coalesce(portal.choices,'[]') end,coalesce(portal.revision,0)+1,a)
  on conflict(workspace_id,client_id) do update set token_hash=excluded.token_hash,choices=excluded.choices,revision=excluded.revision,changed_by=a,updated_at=now();
  return jsonb_build_object('revision',coalesce(portal.revision,0)+1);
 end if;
 raise exception 'Owner required' using errcode='42501';
end $$;
create function public.koi_sensitive_command(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$select koi_private.sensitive_command(action,p)$$;
revoke all on function public.koi_sensitive_command(text,jsonb),koi_private.sensitive_command(text,jsonb) from public,anon;
grant execute on function public.koi_sensitive_command(text,jsonb),koi_private.sensitive_command(text,jsonb) to authenticated;

create function public.koi_read_client_portal(token text,file_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare portal koi_private.client_portals; result jsonb;
begin
 if length(token)=43 then
  select * into portal from koi_private.client_portals where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex');
 end if;
 if portal.client_id is null then raise exception 'Portal unavailable' using errcode='PT404';end if;
 if file_id is not null then
  select jsonb_build_object('name',f.name,'content',encode(f.content,'base64'),'digest',f.digest) into result
   from koi_private.delivery_files f join koi_private.portal_candidates(portal.workspace_id,portal.client_id) t on t.kind='file' and t.id=f.id
   where f.workspace_id=portal.workspace_id and f.id=file_id and portal.choices @> jsonb_build_array(jsonb_build_object('kind','file','id',f.id));
  if result is null then raise exception 'File unavailable' using errcode='PT404';end if;
  return result;
 end if;
 return jsonb_build_object('client',(select name from koi_private.clients where workspace_id=portal.workspace_id and id=portal.client_id),
  'items',(select coalesce(jsonb_agg(to_jsonb(t)||case t.kind
   when 'note' then (select jsonb_build_object('body',body) from koi_private.delivery_items where workspace_id=portal.workspace_id and id=t.id)
   when 'payment' then (select jsonb_build_object('status',status,'due',due_date,'settled',settled_on) from koi_private.finance_movements where workspace_id=portal.workspace_id and id=t.id)
   when 'project' then jsonb_build_object('status',(select status from koi_private.studio_projects where workspace_id=portal.workspace_id and id=t.id),
    'tasks',(select count(*) from koi_private.delivery_items where workspace_id=portal.workspace_id and project_id=t.id and kind='task' and (client_id is null or client_id=portal.client_id)),
    'completed',(select count(*) from koi_private.delivery_items where workspace_id=portal.workspace_id and project_id=t.id and kind='task' and status='done' and (client_id is null or client_id=portal.client_id)),
    'milestones',(select coalesce(jsonb_agg(jsonb_build_object('title',title,'due',due_date,'status',status) order by due_date,id),'[]') from koi_private.delivery_items
     where workspace_id=portal.workspace_id and project_id=t.id and kind='milestone' and (client_id is null or client_id=portal.client_id)))
   else '{}'::jsonb end order by t.kind,t.label,t.id),'[]') from koi_private.portal_candidates(portal.workspace_id,portal.client_id) t
   where portal.choices @> jsonb_build_array(jsonb_build_object('kind',t.kind,'id',t.id))));
end $$;
revoke all on function public.koi_read_client_portal(text,uuid) from public;
grant execute on function public.koi_read_client_portal(text,uuid) to anon,authenticated;
commit;
