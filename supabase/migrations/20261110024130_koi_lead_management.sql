begin;
alter table public.koi_leads add column product text not null default '' check(product in ('','cubiko','zyro','toki','estudio')), add column deleted_at timestamptz;
create index koi_leads_product on public.koi_leads(workspace_id,product) where deleted_at is null;
grant update(product) on public.koi_leads to authenticated;
-- Mutaciones agrupadas, autorizadas por membresía y con control de versión.
create table koi_private.lead_operations (
 workspace_id uuid not null references public.koi_workspaces(id), request_id uuid not null,
 actor_id uuid not null references auth.users(id), body jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(workspace_id,request_id)
);
alter table koi_private.lead_operations enable row level security;
revoke all on koi_private.lead_operations from public,anon,authenticated;
create function koi_private.manage_leads(p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; key uuid:=(p_data->>'key')::uuid; op koi_private.lead_operations;
 l public.koi_leads; item jsonb; patch jsonb:=coalesce(p_data->'patch','{}'); ids uuid[]; lid uuid; answer jsonb; n integer:=0;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or w is null then raise exception 'Membership required' using errcode='42501'; end if;
 if key is null or p_action not in ('create','bulk') then raise exception 'Invalid request' using errcode='22023'; end if;
 -- Mismo orden que el worker. La eliminación no compite con un despacho en curso.
 perform 1 from koi_private.senders where workspace_id=w for update;
 perform 1 from public.koi_workspaces where id=w for update;
 select * into op from koi_private.lead_operations where workspace_id=w and request_id=key;
 if found then
  if op.actor_id<>actor or op.body<>jsonb_build_object('action',p_action,'data',p_data) then raise exception 'Operation conflict' using errcode='PT409'; end if;
  return op.result;
 end if;
 if p_action='create' then
  if exists(select 1 from jsonb_object_keys(p_data) k where k not in ('key','name','phone','company','email','source','product','listIds')) then raise exception 'Invalid fields' using errcode='22023'; end if;
  if coalesce(p_data->>'phone','') !~ '^[1-9][0-9]{9,14}$' then raise exception 'Invalid phone' using errcode='22023'; end if;
  select * into l from public.koi_leads where workspace_id=w and phone=p_data->>'phone' for update;
  if found and l.deleted_at is null then raise exception 'Phone exists' using errcode='PT409'; end if;
  if l.id is not null then
   update public.koi_leads set deleted_at=null,name=coalesce(p_data->>'name',''),company=coalesce(p_data->>'company',''),email=coalesce(p_data->>'email',''),source=coalesce(p_data->>'source',''),product=coalesce(p_data->>'product','') where id=l.id returning * into l;
  else
   insert into public.koi_leads(workspace_id,phone,name,company,email,source,product,created_by) values(w,p_data->>'phone',coalesce(p_data->>'name',''),coalesce(p_data->>'company',''),coalesce(p_data->>'email',''),coalesce(p_data->>'source',''),coalesce(p_data->>'product',''),actor) returning * into l;
  end if;
  for lid in select value::uuid from jsonb_array_elements_text(coalesce(p_data->'listIds','[]')) loop
   if not exists(select 1 from public.koi_lead_lists where workspace_id=w and id=lid) then raise exception 'Foreign list' using errcode='42501'; end if;
   insert into public.koi_lead_list_members(workspace_id,list_id,lead_id) values(w,lid,l.id) on conflict do nothing;
  end loop;
  answer:=jsonb_build_object('id',l.id,'revision',l.revision);
 else
  if coalesce(p_data->>'operation','') not in ('update','delete') or jsonb_typeof(p_data->'leads') is distinct from 'array' or jsonb_array_length(p_data->'leads') not between 1 and 5000 then raise exception 'Invalid selection' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(patch) k where k not in ('product','stage','assignedTo','tags','addListId','removeListId')) then raise exception 'Invalid patch' using errcode='22023'; end if;
  select array_agg((x->>'id')::uuid) into ids from jsonb_array_elements(p_data->'leads') x;
  if cardinality(ids)<>(select count(distinct v) from unnest(ids) v) then raise exception 'Duplicate ids' using errcode='22023'; end if;
  perform 1 from public.koi_leads where workspace_id=w and id=any(ids) order by id for update;
  for item in select value from jsonb_array_elements(p_data->'leads') loop
   select * into l from public.koi_leads where workspace_id=w and id=(item->>'id')::uuid and deleted_at is null;
   if not found then raise exception 'Contact not found' using errcode='PT404'; end if;
   if l.revision is distinct from (item->>'revision')::integer then raise exception 'Stale contact' using errcode='PT409'; end if;
  end loop;
  if p_data->>'operation'='delete' then
   if exists(select 1 from public.koi_campaign_recipients where workspace_id=w and lead_id=any(ids) and status in ('sending','unknown')) then raise exception 'Pending send result' using errcode='PT409'; end if;
   update public.koi_campaign_recipients set status='skipped',reason='lead_deleted',lease_token=null,lease_until=null,updated_at=now() where workspace_id=w and lead_id=any(ids) and status in ('queued','leased');
   update public.koi_leads set deleted_at=now() where workspace_id=w and id=any(ids);
   delete from public.koi_lead_list_members where workspace_id=w and lead_id=any(ids);
  else
   if patch='{}'::jsonb then raise exception 'Empty patch' using errcode='22023'; end if;
   foreach lid in array array[(patch->>'addListId')::uuid,(patch->>'removeListId')::uuid] loop
    if lid is not null and not exists(select 1 from public.koi_lead_lists where workspace_id=w and id=lid) then raise exception 'Foreign list' using errcode='42501'; end if;
   end loop;
   update public.koi_leads set
    product=case when patch?'product' then patch->>'product' else product end,
    stage=case when patch?'stage' then patch->>'stage' else stage end,
    assigned_to=case when patch?'assignedTo' then (patch->>'assignedTo')::uuid else assigned_to end,
    tags=case when patch?'tags' then array(select jsonb_array_elements_text(patch->'tags')) else tags end
    where workspace_id=w and id=any(ids);
   if patch?'addListId' then insert into public.koi_lead_list_members(workspace_id,list_id,lead_id) select w,(patch->>'addListId')::uuid,unnest(ids) on conflict do nothing; end if;
   if patch?'removeListId' then delete from public.koi_lead_list_members where workspace_id=w and list_id=(patch->>'removeListId')::uuid and lead_id=any(ids); end if;
  end if;
  n:=cardinality(ids); answer:=jsonb_build_object('affected',n);
 end if;
 insert into koi_private.lead_operations(workspace_id,request_id,actor_id,body,result) values(w,key,actor,jsonb_build_object('action',p_action,'data',p_data),answer);
 return answer;
end $$;
revoke all on function koi_private.manage_leads(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.manage_leads(text,jsonb) to authenticated;
create function public.koi_manage_leads(p_action text,p_data jsonb) returns jsonb language sql security invoker set search_path='' as $$select koi_private.manage_leads(p_action,p_data)$$;
revoke all on function public.koi_manage_leads(text,jsonb) from public,anon,authenticated;
grant execute on function public.koi_manage_leads(text,jsonb) to authenticated;

create function public.koi_import_update_preview(p_rows jsonb,p_fields jsonb,p_product text default null) returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('phone',l.phone,'revision',l.revision,'before',to_jsonb(l)-'extra','after',r.item) order by l.phone),'[]')
 from (select distinct on (item->>'phone') item from jsonb_array_elements(p_rows) with ordinality x(item,ord) where (item->>'selected')::boolean order by item->>'phone',ord) r
 join public.koi_leads l on l.phone=r.item->>'phone'
 where l.workspace_id=(select workspace_id from public.koi_workspace_members where user_id=auth.uid())
 and (jsonb_array_length(p_fields)>0 or p_product is not null)
$$;
revoke all on function public.koi_import_update_preview(jsonb,jsonb,text) from public,anon;
grant execute on function public.koi_import_update_preview(jsonb,jsonb,text) to authenticated;
create or replace function koi_private.crm_filtered(p jsonb) returns setof public.koi_leads language sql stable security invoker set search_path='' as $$
 select l.* from public.koi_leads l
 where l.deleted_at is null and (coalesce(p->>'product','')='' or l.product=nullif(p->>'product','unassigned') or (p->>'product'='unassigned' and l.product=''))
 and (coalesce(p->>'search','')='' or strpos(lower(concat_ws(' ',l.name,l.company,l.phone,l.email)),lower(p->>'search'))>0)
 and (coalesce(p->>'stage','')='' or l.stage=p->>'stage')
 and (coalesce(p->>'tag','')='' or l.tags @> array[p->>'tag'])
 and (coalesce(p->>'listId','')='' or exists(select 1 from public.koi_lead_list_members m where m.lead_id=l.id and m.workspace_id=l.workspace_id and m.list_id=(p->>'listId')::uuid))
 and (coalesce(p->>'assignedTo','')='' or (p->>'assignedTo'='unassigned' and l.assigned_to is null) or l.assigned_to=nullif(nullif(p->>'assignedTo',''),'unassigned')::uuid)
$$;
create or replace function public.koi_crm_command(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare w uuid; l public.koi_leads; result jsonb; cols jsonb:='[]'; s text; n integer; offset_n integer:=greatest(0,least(coalesce((p_data->>'page')::integer,1),100000)-1)*30; note public.koi_lead_notes;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
 if w is null then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_action in ('create','bulk') then return public.koi_manage_leads(p_action,p_data);
 elsif p_action='options' then
  return jsonb_build_object('members',koi_private.crm_members(),
   'lists',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.koi_lead_lists where workspace_id=w),'[]'),
   'tags',coalesce((select jsonb_agg(t order by t) from (select distinct unnest(tags) t from public.koi_leads where workspace_id=w) x),'[]'));
 elsif p_action='summary' then
 return jsonb_build_object('leads',(select count(*) from public.koi_leads where workspace_id=w and deleted_at is null),'contacted',(select count(distinct r.lead_id) from public.koi_campaign_recipients r join public.koi_leads contacted_lead on contacted_lead.id=r.lead_id where r.workspace_id=w and r.status='accepted' and contacted_lead.deleted_at is null),'campaigns',(select coalesce(jsonb_object_agg(c.status,c.n),'{}') from (select status,count(*) n from public.koi_campaigns where workspace_id=w group by status) c));
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
 select * into l from public.koi_leads where id=(p_data->>'id')::uuid and workspace_id=w and deleted_at is null;
 if not found then raise exception 'Contact not found' using errcode='PT404'; end if;
 if p_action='detail' then
  return jsonb_build_object('lead',to_jsonb(l),'lists',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.name) from public.koi_lead_lists b join public.koi_lead_list_members m on m.list_id=b.id where m.lead_id=l.id and m.workspace_id=w),'[]'),
   'suppressed',exists(select 1 from public.koi_suppressions where workspace_id=w and phone=l.phone),
   'lastContactAt',(select max(updated_at) from public.koi_campaign_recipients where lead_id=l.id and workspace_id=w and status='accepted'));
 elsif p_action='update' then
  update public.koi_leads set
   product=case when p_data?'product' then p_data->>'product' else product end,
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
create or replace function koi_private.commit_import(p_import_id uuid, p_key uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  draft public.koi_imports%rowtype;
  member_workspace uuid;
  target_id uuid;
  target_name text;
  fingerprint text := encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  existing public.koi_leads; update_fields text[]; product_value text; n_updated integer:=0; item jsonb; original jsonb; contact_id uuid; canonical_phone text; consent_state text; evidence text;
  result_row text; affected integer; is_new boolean; is_selected boolean;
  seen text[] := '{}'; source_number integer;
  n_created integer := 0; n_linked integer := 0; n_already integer := 0; n_duplicates integer := 0; n_excluded integer := 0; n_selected integer := 0; n_blocked integer := 0;
  import_result jsonb;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select workspace_id into member_workspace from public.koi_workspace_members where user_id = actor and role in ('admin','operator');
  if member_workspace is null then raise exception 'Membership required' using errcode = '42501'; end if;
  select array(select jsonb_array_elements_text(coalesce(p_payload->'choices'->'updateFields','[]'))) into update_fields;
  if exists(select 1 from unnest(update_fields) f where f not in ('name','company','email','source')) then raise exception 'Invalid update fields' using errcode='22023'; end if;
  product_value:=p_payload->'choices'->>'product';
  -- Serializa imports del mismo equipo y evita carreras entre listas sobre un teléfono.
  perform 1 from public.koi_workspaces where id = member_workspace for update;
  select * into draft from public.koi_imports where id = p_import_id and workspace_id = member_workspace and created_by = actor for update;
  if not found then raise exception 'Import not found' using errcode = '42501'; end if;
  if p_key is null or p_payload is null then raise exception 'Missing request' using errcode = '22023'; end if;
  if draft.status = 'committed' then
    if draft.commit_key = p_key and draft.commit_hash = fingerprint then return draft.result; end if;
    raise exception 'Import already committed with another request' using errcode = 'PT409';
  end if;
  if coalesce((p_payload->'choices'->>'revision')::integer,0) <> draft.revision then raise exception 'Stale draft' using errcode = 'PT409'; end if;
  if jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows') <> jsonb_array_length(draft.payload->'rows') or octet_length(p_payload::text) > 20000000 then
    raise exception 'Invalid rows' using errcode = '22023';
  end if;
  if p_payload->'target' ? 'listId' then
    target_id := (p_payload->'target'->>'listId')::uuid;
    if not exists(select 1 from public.koi_lead_lists where id = target_id and workspace_id = member_workspace) then raise exception 'List outside workspace' using errcode = '42501'; end if;
  else
    target_name := btrim(p_payload->'target'->>'name');
    if target_name is null or char_length(target_name) not between 1 and 100 or char_length(coalesce(p_payload->'target'->>'description','')) > 500 then raise exception 'Invalid list' using errcode = '22023'; end if;
    insert into public.koi_lead_lists(workspace_id,name,description,request_id,created_by)
      values(member_workspace,target_name,coalesce(p_payload->'target'->>'description',''),gen_random_uuid(),actor) returning id into target_id;
  end if;
  for item, original in
    select r.value, s.value from jsonb_array_elements(p_payload->'rows') with ordinality r
    join jsonb_array_elements(draft.payload->'rows') with ordinality s on s.ordinality = r.ordinality
  loop
    source_number := (item->>'row')::integer;
    if source_number is null or source_number is distinct from (original->>'row')::integer then raise exception 'Invalid source row' using errcode = '22023'; end if;
    is_selected := (item->>'selected')::boolean;
    if is_selected is null then raise exception 'Missing selection' using errcode = '22023'; end if;
    contact_id := null;
    if not is_selected then result_row := 'excluded'; n_excluded := n_excluded + 1;
    else
      n_selected := n_selected + 1;
      canonical_phone := item->>'phone'; consent_state := item->'consent'->>'state'; evidence := btrim(item->'consent'->>'evidence');
      if canonical_phone is null or canonical_phone !~ '^[1-9][0-9]{9,14}$' or coalesce(item->>'error','') <> '' or consent_state is null or consent_state not in ('unknown','granted','denied') or (consent_state <> 'unknown' and (evidence is null or char_length(evidence) not between 1 and 1000)) then
        raise exception 'Invalid selected contact' using errcode = '22023';
      end if;
      -- Un rechazo tiene prioridad incluso en filas duplicadas y contactos existentes.
      if consent_state = 'denied' then
        insert into public.koi_suppressions(workspace_id,phone,reason) values(member_workspace,canonical_phone,evidence) on conflict do nothing;
      end if;
      if canonical_phone = any(seen) then
        result_row := 'duplicate'; n_duplicates := n_duplicates + 1;
        select id into contact_id from public.koi_leads where workspace_id = member_workspace and phone = canonical_phone;
      else
        seen := array_append(seen,canonical_phone);
        insert into public.koi_leads(workspace_id,phone,name,company,email,source,extra,consent,created_by)
          values(member_workspace,canonical_phone,coalesce(item->>'name',''),coalesce(item->>'company',''),coalesce(item->>'email',''),coalesce(item->>'source',''),coalesce(item->'extra','{}'),consent_state,actor)
          on conflict (workspace_id,phone) do nothing returning id into contact_id;
        is_new := found;
        if not is_new then
          select * into existing from public.koi_leads where workspace_id=member_workspace and phone=canonical_phone for update;
          contact_id:=existing.id;
          if existing.deleted_at is not null then raise exception 'Deleted contact: recreate manually' using errcode='PT409'; end if;
          if cardinality(update_fields)>0 or product_value is not null then
            if existing.revision is distinct from (p_payload->'choices'->'expectedRevisions'->>canonical_phone)::integer then raise exception 'Stale contact' using errcode='PT409'; end if;
            update public.koi_leads set name=case when 'name'=any(update_fields) then coalesce(item->>'name','') else name end,
             company=case when 'company'=any(update_fields) then coalesce(item->>'company','') else company end,
             email=case when 'email'=any(update_fields) then coalesce(item->>'email','') else email end,
             source=case when 'source'=any(update_fields) then coalesce(item->>'source','') else source end,
             product=coalesce(product_value,product) where id=contact_id;
            n_updated:=n_updated+1;
          end if;
        elsif product_value is not null then update public.koi_leads set product=product_value where id=contact_id; end if;
        insert into public.koi_lead_list_members(workspace_id,list_id,lead_id) values(member_workspace,target_id,contact_id) on conflict do nothing;
        get diagnostics affected = row_count;
        if is_new then result_row := 'created'; n_created := n_created + 1;
        elsif affected = 1 then result_row := 'linked'; n_linked := n_linked + 1;
        else result_row := 'already_linked'; n_already := n_already + 1; end if;
        if is_new and consent_state = 'granted' then
          insert into public.koi_consent_records(workspace_id,lead_id,import_id,state,evidence,actor_id) values(member_workspace,contact_id,draft.id,consent_state,evidence,actor);
        end if;
      end if;
      if consent_state = 'denied' then
        insert into public.koi_consent_records(workspace_id,lead_id,import_id,state,evidence,actor_id) values(member_workspace,contact_id,draft.id,consent_state,evidence,actor);
      end if;
    end if;
    insert into public.koi_import_rows(workspace_id,import_id,source_row,original,prepared,selected,outcome,lead_id)
      values(member_workspace,draft.id,source_number,original,item,is_selected,result_row,contact_id);
  end loop;
  if n_selected = 0 then raise exception 'Select at least one row' using errcode = '22023'; end if;
  select count(*) into n_blocked from public.koi_suppressions where workspace_id = member_workspace and phone = any(seen);
  import_result := jsonb_build_object('importId',draft.id,'listId',target_id,'total',jsonb_array_length(p_payload->'rows'),'selected',n_selected,'created',n_created,'linked',n_linked,'alreadyLinked',n_already,'duplicates',n_duplicates,'excluded',n_excluded,'blocked',n_blocked,'updated',n_updated);
  update public.koi_imports set status = 'committed', commit_key = p_key, commit_hash = fingerprint, result = import_result, choices=p_payload->'choices', committed_at = now() where id = draft.id;
  insert into public.koi_audit_events(workspace_id,actor_id,action,resource_id,details) values(member_workspace,actor,'import.committed',target_id,import_result);
  return import_result;
end;
$$;

commit;
