begin;
-- Registry contains only public identifiers. Credentials stay in the API environment.
create table public.koi_whatsapp_instances (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.koi_workspaces(id),
 label text not null check(label=btrim(label) and char_length(label) between 1 and 60),
 instance_name text generated always as ('koi-' || replace(id::text,'-','')) stored unique,
 request_id uuid not null,
 created_at timestamptz not null default now(),
 unique(workspace_id,request_id)
);
alter table public.koi_whatsapp_instances enable row level security;
revoke all on public.koi_whatsapp_instances from public,anon,authenticated;
grant select on public.koi_whatsapp_instances to authenticated;
grant insert(workspace_id,label,request_id) on public.koi_whatsapp_instances to authenticated;
create policy koi_whatsapp_read on public.koi_whatsapp_instances for select to authenticated using (
 exists(select 1 from public.koi_workspace_members m where m.workspace_id=koi_whatsapp_instances.workspace_id and m.user_id=(select auth.uid()))
);
create policy koi_whatsapp_admin_create on public.koi_whatsapp_instances for insert to authenticated with check (
 exists(select 1 from public.koi_workspace_members m where m.workspace_id=koi_whatsapp_instances.workspace_id and m.user_id=(select auth.uid()) and m.role='admin')
);
-- No client can choose or rewrite provider identifiers, so another project's instance cannot be adopted.
create function koi_private.limit_whatsapp_instances() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.workspace_id::text,913));
 if (select count(*) from public.koi_whatsapp_instances where workspace_id=new.workspace_id)>=10 then
  raise exception 'Instance limit reached' using errcode='23514';
 end if;
 return new;
end;
$$;
revoke all on function koi_private.limit_whatsapp_instances() from public,anon,authenticated;
create trigger koi_whatsapp_limit before insert on public.koi_whatsapp_instances for each row execute function koi_private.limit_whatsapp_instances();
commit;
