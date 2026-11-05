-- Koi: instalación independiente. No aplicar las migraciones históricas de Casadey.
begin;

create schema if not exists koi_private;
revoke all on schema koi_private from public, anon, authenticated;

create table public.koi_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  created_at timestamptz not null default now()
);

create table public.koi_workspace_members (
  workspace_id uuid not null references public.koi_workspaces(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('admin', 'operator')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  unique (user_id)
);

create table public.koi_lead_lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  request_id uuid not null,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_id)
);
create unique index koi_lists_unique_name on public.koi_lead_lists (workspace_id, lower(name));
create index koi_lists_workspace_created on public.koi_lead_lists (workspace_id, created_at desc, id);
create index koi_lists_created_by on public.koi_lead_lists (created_by);

create table public.koi_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  actor_id uuid not null references auth.users(id),
  action text not null check (action in ('lead_list.created', 'lead_list.updated')),
  resource_id uuid not null references public.koi_lead_lists(id),
  details jsonb not null,
  created_at timestamptz not null default now()
);
create index koi_audit_workspace_created on public.koi_audit_events (workspace_id, created_at desc);
create index koi_audit_actor on public.koi_audit_events (actor_id);
create index koi_audit_resource on public.koi_audit_events (resource_id);

alter table public.koi_workspaces enable row level security;
alter table public.koi_workspace_members enable row level security;
alter table public.koi_lead_lists enable row level security;
alter table public.koi_audit_events enable row level security;

revoke all on public.koi_workspaces, public.koi_workspace_members, public.koi_lead_lists, public.koi_audit_events from public, anon, authenticated;
grant select on public.koi_workspaces, public.koi_workspace_members, public.koi_lead_lists, public.koi_audit_events to authenticated;
grant insert (workspace_id, name, description, request_id, created_by) on public.koi_lead_lists to authenticated;
grant update (name, description) on public.koi_lead_lists to authenticated;

create policy koi_members_self on public.koi_workspace_members for select to authenticated
  using (user_id = (select auth.uid()));

create policy koi_workspaces_member on public.koi_workspaces for select to authenticated
  using (exists (select 1 from public.koi_workspace_members m where m.workspace_id = id and m.user_id = (select auth.uid())));

create policy koi_lists_read on public.koi_lead_lists for select to authenticated
  using (exists (select 1 from public.koi_workspace_members m where m.workspace_id = koi_lead_lists.workspace_id and m.user_id = (select auth.uid())));

create policy koi_lists_insert on public.koi_lead_lists for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (
    select 1 from public.koi_workspace_members m where m.workspace_id = koi_lead_lists.workspace_id and m.user_id = (select auth.uid()) and m.role in ('admin', 'operator')
  ));

create policy koi_lists_update on public.koi_lead_lists for update to authenticated
  using (exists (select 1 from public.koi_workspace_members m where m.workspace_id = koi_lead_lists.workspace_id and m.user_id = (select auth.uid()) and m.role in ('admin', 'operator')))
  with check (exists (select 1 from public.koi_workspace_members m where m.workspace_id = koi_lead_lists.workspace_id and m.user_id = (select auth.uid()) and m.role in ('admin', 'operator')));

create policy koi_audit_admin on public.koi_audit_events for select to authenticated
  using (exists (select 1 from public.koi_workspace_members m where m.workspace_id = koi_audit_events.workspace_id and m.user_id = (select auth.uid()) and m.role = 'admin'));

create function koi_private.touch_list() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function koi_private.touch_list() from public, anon, authenticated;
create trigger koi_list_updated before update on public.koi_lead_lists for each row execute function koi_private.touch_list();

-- Elevación acotada al trigger: usuarios no pueden insertar ni falsificar auditoría.
-- No es una RPC expuesta y deriva actor/recurso de la fila, nunca del cliente.
create function koi_private.audit_list() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Authenticated actor required' using errcode = '42501';
  end if;
  insert into public.koi_audit_events (workspace_id, actor_id, action, resource_id, details)
  values (new.workspace_id, auth.uid(),
    case when tg_op = 'INSERT' then 'lead_list.created' else 'lead_list.updated' end,
    new.id,
    jsonb_build_object('name', new.name, 'description', new.description));
  return new;
end;
$$;
revoke all on function koi_private.audit_list() from public, anon, authenticated;
create trigger koi_list_audit after insert or update on public.koi_lead_lists for each row execute function koi_private.audit_list();

commit;
