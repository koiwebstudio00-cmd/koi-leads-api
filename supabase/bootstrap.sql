-- Ejecutar manualmente en SQL Editor del proyecto Koi, después de crear el usuario en Auth.
-- Reemplazar el email. No agrega contraseñas al repositorio y no envía invitaciones.
do $$
declare
  member_id uuid;
  workspace_id uuid;
begin
  select id into member_id from auth.users where email = 'REEMPLAZAR_EMAIL_ADMIN';
  if member_id is null then raise exception 'Primero crear el usuario Auth y reemplazar el email del script'; end if;
  if exists (select 1 from public.koi_workspace_members where user_id = member_id) then
    raise notice 'El usuario ya pertenece a un espacio; no se cambió su rol';
    return;
  end if;
  insert into public.koi_workspaces(name) values ('Estudio Koi') returning id into workspace_id;
  insert into public.koi_workspace_members(workspace_id,user_id,role) values (workspace_id,member_id,'admin');
end;
$$;
