begin;

alter table public.koi_lead_lists add constraint koi_lists_workspace_id_key unique (workspace_id, id);
alter table public.koi_audit_events drop constraint koi_audit_events_action_check;
alter table public.koi_audit_events add constraint koi_audit_events_action_check check (action in ('lead_list.created', 'lead_list.updated', 'import.committed'));

create table public.koi_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  phone text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  name text not null default '' check (char_length(name) <= 250),
  company text not null default '' check (char_length(company) <= 250),
  email text not null default '' check (char_length(email) <= 250),
  source text not null default '' check (char_length(source) <= 250),
  extra jsonb not null default '{}' check (jsonb_typeof(extra) = 'object' and octet_length(extra::text) <= 100000),
  consent text not null default 'unknown' check (consent in ('unknown','granted','denied')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, phone), unique (workspace_id, id)
);
create index koi_leads_created_by on public.koi_leads(created_by);

create table public.koi_lead_list_members (
  workspace_id uuid not null,
  list_id uuid not null,
  lead_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (list_id, lead_id),
  foreign key (workspace_id, list_id) references public.koi_lead_lists(workspace_id,id),
  foreign key (workspace_id, lead_id) references public.koi_leads(workspace_id,id)
);
create index koi_list_members_lead on public.koi_lead_list_members(workspace_id,lead_id);
create index koi_list_members_list on public.koi_lead_list_members(workspace_id,list_id,created_at,lead_id);

create table public.koi_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  created_by uuid not null default auth.uid() references auth.users(id),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 10000000 and jsonb_typeof(payload->'rows') = 'array' and jsonb_array_length(payload->'rows') between 1 and 5000),
  filename text generated always as (payload->>'filename') stored,
  status text not null default 'draft' check (status in ('draft','committed')),
  commit_key uuid,
  commit_hash text,
  result jsonb,
  choices jsonb,
  revision integer not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique (workspace_id,id),
  check ((status = 'draft' and commit_key is null and result is null and committed_at is null) or (status = 'committed' and commit_key is not null and result is not null and committed_at is not null))
);
create index koi_imports_owner on public.koi_imports(workspace_id,created_by,created_at desc);
create index koi_imports_creator on public.koi_imports(created_by);

create table public.koi_import_rows (
  workspace_id uuid not null,
  import_id uuid not null,
  source_row integer not null check (source_row > 0),
  original jsonb not null,
  prepared jsonb not null,
  selected boolean not null,
  outcome text not null check (outcome in ('created','linked','already_linked','duplicate','excluded')),
  lead_id uuid,
  primary key (import_id,source_row),
  foreign key (workspace_id,import_id) references public.koi_imports(workspace_id,id),
  foreign key (workspace_id,lead_id) references public.koi_leads(workspace_id,id)
);
create index koi_import_rows_workspace on public.koi_import_rows(workspace_id,import_id);
create index koi_import_rows_lead on public.koi_import_rows(workspace_id,lead_id);

create table public.koi_suppressions (
  workspace_id uuid not null references public.koi_workspaces(id),
  phone text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  reason text not null check (char_length(reason) between 1 and 1000),
  created_at timestamptz not null default now(),
  primary key (workspace_id,phone)
);
create table public.koi_consent_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  lead_id uuid not null,
  import_id uuid not null,
  state text not null check (state in ('granted','denied')),
  evidence text not null check (char_length(btrim(evidence)) between 1 and 1000),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (workspace_id,lead_id) references public.koi_leads(workspace_id,id),
  foreign key (workspace_id,import_id) references public.koi_imports(workspace_id,id)
);
create index koi_consent_lead on public.koi_consent_records(workspace_id,lead_id);
create index koi_consent_import on public.koi_consent_records(workspace_id,import_id);
create index koi_consent_actor on public.koi_consent_records(actor_id);

-- Ninguna escritura comercial directa desde REST: el commit es una única transacción.
do $$ declare table_name text; begin
  foreach table_name in array array['koi_leads','koi_lead_list_members','koi_imports','koi_import_rows','koi_suppressions','koi_consent_records'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('create policy member_read on public.%I for select to authenticated using (exists (select 1 from public.koi_workspace_members m where m.workspace_id = %I.workspace_id and m.user_id = (select auth.uid())))', table_name, table_name);
  end loop;
end $$;
grant insert (workspace_id,created_by,payload) on public.koi_imports to authenticated;
create policy imports_create on public.koi_imports for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (select 1 from public.koi_workspace_members m where m.workspace_id = koi_imports.workspace_id and m.user_id = (select auth.uid())));

-- SECURITY DEFINER acotado a la transacción de confirmación. Sin acceso de escritura
-- directo a contactos, resultados ni consentimiento; autorización explícita por membresía
-- y propietario del borrador, sin workspace confiado al cliente ni SQL dinámico.
create function koi_private.commit_import(p_import_id uuid, p_key uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  draft public.koi_imports%rowtype;
  member_workspace uuid;
  target_id uuid;
  target_name text;
  fingerprint text := encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  item jsonb; original jsonb; contact_id uuid; canonical_phone text; consent_state text; evidence text;
  result_row text; affected integer; is_new boolean; is_selected boolean;
  seen text[] := '{}'; source_number integer;
  n_created integer := 0; n_linked integer := 0; n_already integer := 0; n_duplicates integer := 0; n_excluded integer := 0; n_selected integer := 0; n_blocked integer := 0;
  import_result jsonb;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select workspace_id into member_workspace from public.koi_workspace_members where user_id = actor and role in ('admin','operator');
  if member_workspace is null then raise exception 'Membership required' using errcode = '42501'; end if;
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
        if not is_new then select id into contact_id from public.koi_leads where workspace_id = member_workspace and phone = canonical_phone; end if;
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
  import_result := jsonb_build_object('importId',draft.id,'listId',target_id,'total',jsonb_array_length(p_payload->'rows'),'selected',n_selected,'created',n_created,'linked',n_linked,'alreadyLinked',n_already,'duplicates',n_duplicates,'excluded',n_excluded,'blocked',n_blocked);
  update public.koi_imports set status = 'committed', commit_key = p_key, commit_hash = fingerprint, result = import_result, choices=p_payload->'choices', committed_at = now() where id = draft.id;
  insert into public.koi_audit_events(workspace_id,actor_id,action,resource_id,details) values(member_workspace,actor,'import.committed',target_id,import_result);
  return import_result;
end;
$$;
revoke all on function koi_private.commit_import(uuid,uuid,jsonb) from public,anon,authenticated;
grant usage on schema koi_private to authenticated;
grant execute on function koi_private.commit_import(uuid,uuid,jsonb) to authenticated;
create function public.koi_commit_import(p_import_id uuid,p_key uuid,p_payload jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select koi_private.commit_import(p_import_id,p_key,p_payload); $$;
revoke all on function public.koi_commit_import(uuid,uuid,jsonb) from public,anon;
grant execute on function public.koi_commit_import(uuid,uuid,jsonb) to authenticated;

-- Un único objeto evita que el límite de filas REST recorte conteos de archivos grandes.
create function public.koi_check_import_phones(p_phones text[]) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare answer jsonb;
begin
  if p_phones is null or cardinality(p_phones) > 5000 then raise exception 'Invalid phone count' using errcode = '22023'; end if;
  with member as (select workspace_id from public.koi_workspace_members where user_id = (select auth.uid())),
  checked as (
    select p.phone,
      exists(select 1 from public.koi_leads l where l.workspace_id=m.workspace_id and l.phone=p.phone) as existing,
      exists(select 1 from public.koi_suppressions s where s.workspace_id=m.workspace_id and s.phone=p.phone) as blocked
    from (select distinct unnest(p_phones) as phone) p cross join member m
  ) select jsonb_build_object('newContacts',count(*) filter(where not existing),'existingContacts',count(*) filter(where existing),'blocked',count(*) filter(where blocked)) into answer from checked;
  return answer;
end;
$$;
revoke all on function public.koi_check_import_phones(text[]) from public,anon;
grant execute on function public.koi_check_import_phones(text[]) to authenticated;

create function koi_private.save_import_draft(p_import_id uuid,p_revision integer,p_choices jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare draft public.koi_imports%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select i.* into draft from public.koi_imports i join public.koi_workspace_members m on m.workspace_id=i.workspace_id
    where i.id=p_import_id and i.created_by=auth.uid() and m.user_id=auth.uid() and m.role in ('admin','operator') for update of i;
  if not found then raise exception 'Import not found' using errcode = '42501'; end if;
  if draft.status <> 'draft' or p_revision is distinct from draft.revision then raise exception 'Stale draft' using errcode = 'PT409'; end if;
  if p_choices is null or jsonb_typeof(p_choices) <> 'object' or octet_length(p_choices::text) > 10000000 then raise exception 'Invalid choices' using errcode = '22023'; end if;
  update public.koi_imports set choices=p_choices,revision=revision+1 where id=draft.id;
  return draft.revision+1;
end;
$$;
revoke all on function koi_private.save_import_draft(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function koi_private.save_import_draft(uuid,integer,jsonb) to authenticated;
create function public.koi_save_import_draft(p_import_id uuid,p_revision integer,p_choices jsonb)
returns integer language sql security invoker set search_path = '' as $$ select koi_private.save_import_draft(p_import_id,p_revision,p_choices); $$;
revoke all on function public.koi_save_import_draft(uuid,integer,jsonb) from public,anon;
grant execute on function public.koi_save_import_draft(uuid,integer,jsonb) to authenticated;
commit;
