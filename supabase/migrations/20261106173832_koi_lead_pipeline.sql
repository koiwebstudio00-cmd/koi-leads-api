begin;
alter table public.koi_leads
 add column stage text not null default 'new' check(stage in ('new','contacted','replied','interested','proposal','won','lost')),
 add column tags text[] not null default '{}' check(cardinality(tags)<=20 and length(array_to_string(tags,''))<=800),
 add column assigned_to uuid,
 add column next_action text not null default '' check(length(next_action)<=500),
 add column next_action_at timestamptz,
 add column updated_at timestamptz not null default now(),
 add constraint koi_lead_assignee foreign key(workspace_id,assigned_to) references public.koi_workspace_members(workspace_id,user_id);
create index koi_leads_pipeline on public.koi_leads(workspace_id,stage,created_at desc,id);
create index koi_leads_assignee on public.koi_leads(workspace_id,assigned_to);
create index koi_leads_tags on public.koi_leads using gin(tags);
grant update(stage,tags,assigned_to,next_action,next_action_at) on public.koi_leads to authenticated;
create or replace function koi_private.lead_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from unnest(new.tags) t where t is null or length(btrim(t)) not between 1 and 40) then raise exception 'Invalid tags' using errcode='22023'; end if;
 new.tags:=array(select distinct btrim(t) from unnest(new.tags) t order by btrim(t));
 new.revision:=old.revision+1; new.updated_at:=now(); return new;
end $$;

create table public.koi_lead_notes(
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, lead_id uuid not null,
 body text not null check(length(btrim(body)) between 1 and 4000),
 actor_id uuid not null default auth.uid() references auth.users(id),
 request_id uuid not null, created_at timestamptz not null default now(),
 foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id), unique(workspace_id,request_id)
);
create index koi_notes_lead on public.koi_lead_notes(workspace_id,lead_id,created_at desc,id);
create index koi_notes_actor on public.koi_lead_notes(actor_id);
alter table public.koi_lead_notes enable row level security;
revoke all on public.koi_lead_notes from public,anon,authenticated;
grant select on public.koi_lead_notes to authenticated;
grant insert(workspace_id,lead_id,body,request_id) on public.koi_lead_notes to authenticated;
create policy member_read on public.koi_lead_notes for select to authenticated using(exists(select 1 from public.koi_workspace_members m where m.workspace_id=koi_lead_notes.workspace_id and m.user_id=(select auth.uid())));
create policy member_insert on public.koi_lead_notes for insert to authenticated with check(actor_id=(select auth.uid()) and exists(select 1 from public.koi_workspace_members m where m.workspace_id=koi_lead_notes.workspace_id and m.user_id=(select auth.uid())));

-- Narrow privileged lookup: only names/emails of members of the caller's workspace.
-- No client-supplied workspace and no access to other Auth columns.
create function koi_private.crm_members() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'label',coalesce(nullif(to_jsonb(u)->>'email',''),'Miembro '||left(m.user_id::text,8)),'role',m.role) order by m.created_at),'[]')
 from public.koi_workspace_members m join auth.users u on u.id=m.user_id
 where auth.uid() is not null and m.workspace_id=(select workspace_id from public.koi_workspace_members where user_id=auth.uid())
$$;
revoke all on function koi_private.crm_members() from public,anon,authenticated;
grant execute on function koi_private.crm_members() to authenticated;

create function koi_private.crm_filtered(p jsonb) returns setof public.koi_leads language sql stable security invoker set search_path='' as $$
 select l.* from public.koi_leads l
 where (coalesce(p->>'search','')='' or strpos(lower(concat_ws(' ',l.name,l.company,l.phone,l.email)),lower(p->>'search'))>0)
 and (coalesce(p->>'stage','')='' or l.stage=p->>'stage')
 and (coalesce(p->>'tag','')='' or l.tags @> array[p->>'tag'])
 and (coalesce(p->>'listId','')='' or exists(select 1 from public.koi_lead_list_members m where m.lead_id=l.id and m.workspace_id=l.workspace_id and m.list_id=(p->>'listId')::uuid))
 and (coalesce(p->>'assignedTo','')='' or (p->>'assignedTo'='unassigned' and l.assigned_to is null) or l.assigned_to=nullif(nullif(p->>'assignedTo',''),'unassigned')::uuid)
$$;
revoke all on function koi_private.crm_filtered(jsonb) from public,anon,authenticated;
grant execute on function koi_private.crm_filtered(jsonb) to authenticated;

create function public.koi_crm_command(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare w uuid; l public.koi_leads; result jsonb; cols jsonb:='[]'; s text; n integer; offset_n integer:=greatest(0,least(coalesce((p_data->>'page')::integer,1),100000)-1)*30; note public.koi_lead_notes;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
 if w is null then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_action='options' then
  return jsonb_build_object('members',koi_private.crm_members(),
   'lists',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.koi_lead_lists where workspace_id=w),'[]'),
   'tags',coalesce((select jsonb_agg(t order by t) from (select distinct unnest(tags) t from public.koi_leads where workspace_id=w) x),'[]'));
 elsif p_action='list' then
  select count(*) into n from koi_private.crm_filtered(p_data);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id),'[]') into result from (select * from koi_private.crm_filtered(p_data) order by created_at desc,id limit 30 offset offset_n) q;
  return jsonb_build_object('leads',result,'total',n);
 elsif p_action='board' then
  foreach s in array array['new','contacted','replied','interested','proposal','won','lost'] loop
   select count(*) into n from koi_private.crm_filtered(p_data) f where f.stage=s;
   select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id),'[]') into result from (select * from koi_private.crm_filtered(p_data) f where f.stage=s order by created_at desc,id limit 30) q;
   cols:=cols||jsonb_build_array(jsonb_build_object('stage',s,'total',n,'leads',result));
  end loop;
  return jsonb_build_object('columns',cols);
 end if;
 select * into l from public.koi_leads where id=(p_data->>'id')::uuid and workspace_id=w;
 if not found then raise exception 'Contact not found' using errcode='PT404'; end if;
 if p_action='detail' then
  return jsonb_build_object('lead',to_jsonb(l),'lists',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.name) from public.koi_lead_lists b join public.koi_lead_list_members m on m.list_id=b.id where m.lead_id=l.id and m.workspace_id=w),'[]'),
   'suppressed',exists(select 1 from public.koi_suppressions where workspace_id=w and phone=l.phone),
   'lastContactAt',(select max(updated_at) from public.koi_campaign_recipients where lead_id=l.id and workspace_id=w and status='accepted'));
 elsif p_action='update' then
  update public.koi_leads set
   stage=case when p_data?'stage' then p_data->>'stage' else stage end,
   tags=case when p_data?'tags' then array(select jsonb_array_elements_text(p_data->'tags')) else tags end,
   assigned_to=case when p_data?'assignedTo' then (p_data->>'assignedTo')::uuid else assigned_to end,
   next_action=case when p_data?'nextAction' then btrim(p_data->>'nextAction') else next_action end,
   next_action_at=case when p_data?'nextActionAt' then (p_data->>'nextActionAt')::timestamptz else next_action_at end
  where id=l.id and workspace_id=w and revision=(p_data->>'revision')::integer returning * into l;
  if not found then raise exception 'Stale contact' using errcode='PT409'; end if;
  return to_jsonb(l);
 elsif p_action='note' then
  select * into note from public.koi_lead_notes where workspace_id=w and request_id=(p_data->>'key')::uuid;
  if not found then
   insert into public.koi_lead_notes(workspace_id,lead_id,body,request_id) values(w,l.id,btrim(p_data->>'body'),(p_data->>'key')::uuid) on conflict(workspace_id,request_id) do nothing;
   select * into note from public.koi_lead_notes where workspace_id=w and request_id=(p_data->>'key')::uuid;
  end if;
  if note.lead_id<>l.id or note.body<>btrim(p_data->>'body') or note.actor_id<>auth.uid() then raise exception 'Note key conflict' using errcode='PT409'; end if;
  return to_jsonb(note);
 elsif p_action='notes' then
  return jsonb_build_object('total',(select count(*) from public.koi_lead_notes where lead_id=l.id and workspace_id=w),'notes',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id) from (select * from public.koi_lead_notes where lead_id=l.id and workspace_id=w order by created_at desc,id limit 30 offset offset_n) q),'[]'));
 elsif p_action='history' then
  return jsonb_build_object('total',(select count(*) from public.koi_campaign_recipients where lead_id=l.id and workspace_id=w),'history',coalesce((select jsonb_agg(to_jsonb(q) order by q.updated_at desc,q.id) from (select r.id,r.campaign_id,c.name as campaign_name,r.status,r.delivery,r.message,r.updated_at from public.koi_campaign_recipients r join public.koi_campaigns c on c.id=r.campaign_id where r.lead_id=l.id and r.workspace_id=w order by r.updated_at desc,r.id limit 30 offset offset_n) q),'[]'));
 end if;
 raise exception 'Unknown CRM action' using errcode='22023';
end $$;
revoke all on function public.koi_crm_command(text,jsonb) from public,anon,authenticated;
grant execute on function public.koi_crm_command(text,jsonb) to authenticated;
commit;
