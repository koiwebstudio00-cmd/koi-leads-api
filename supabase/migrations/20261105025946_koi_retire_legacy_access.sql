-- El propietario confirmó el 2026-11-05 que la aplicación anterior ya no se usa.
-- Conserva tablas, filas, funciones y políticas; retira su acceso desde la API pública.
begin;
revoke create on schema public from public, anon, authenticated;
do $$
declare legacy_table text; legacy_function regprocedure;
begin
  foreach legacy_table in array array['services','media','blog','payments','orders','profile','config','students','courses','courseCategories','carreras','institutos','posgrados','revistas_cientificas','utilidades','service_type','horarios_cursado','horarios_cursado_detalle','horarios_examenes','horarios_examenes_detalle','extension','leads'] loop
    if to_regclass(format('public.%I',legacy_table)) is not null then
      execute format('alter table public.%I enable row level security',legacy_table);
      execute format('revoke all on table public.%I from public, anon, authenticated',legacy_table);
    end if;
  end loop;
  for legacy_function in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('generate_slug','immutable_unaccent','remove_accents','search_global','search_global_count','set_slug_from_name','set_slug_from_nombre_service','set_slug_from_title_blog')
  loop
    execute format('revoke all on function %s from public, anon, authenticated',legacy_function);
    execute format('alter function %s set search_path = pg_catalog, public, extensions',legacy_function);
  end loop;
end $$;
commit;
