-- Complete inbox summaries, paged by immutable identity; message histories stay on demand.
create index if not exists koi_conversation_inbox_index
  on public.koi_conversations(workspace_id,id) where deleted_at is null;

create function koi_private.chat_inbox_index(data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); w uuid; member_role text;
  after_id uuid:=(data->>'after')::uuid; requested uuid[];
  items jsonb; next_id uuid;
begin
  select workspace_id,role into w,member_role from public.koi_workspace_members where user_id=actor;
  if actor is null or w is null or member_role not in ('admin','operator') then
    raise exception 'Membership required' using errcode='42501';
  end if;
  if data ? 'ids' then
    if jsonb_typeof(data->'ids')<>'array' then raise exception 'Invalid ids' using errcode='22023'; end if;
    if jsonb_array_length(data->'ids') not between 1 and 100 or after_id is not null then
      raise exception 'Invalid ids' using errcode='22023';
    end if;
    select array_agg(value::uuid) into requested from jsonb_array_elements_text(data->'ids');
  end if;
  with candidates as materialized (
    select x.* from public.koi_conversations x
    where x.workspace_id=w and x.deleted_at is null
      and (after_id is null or x.id>after_id)
      and (requested is null or x.id=any(requested))
      and exists(select 1 from koi_private.chat_instances(w) i where i.instance=x.instance)
      and exists(select 1 from koi_private.chat_messages m where m.conversation_id=x.id)
    order by x.id limit 201
  ), page as materialized (
    select x.id,koi_private.chat_row(x::public.koi_conversations,actor) item
    from (select * from candidates order by id limit 200) x
  )
  select coalesce(jsonb_agg(
    jsonb_set(item,'{last_message}',
      ((item->'last_message')-'quote'-'reactions') || jsonb_build_object('body',left(item->'last_message'->>'body',300)))
    order by id),'[]'),
    case when (select count(*) from candidates)>200 then (select id from page order by id desc limit 1) end
  into items,next_id from page;
  return jsonb_build_object('userId',actor,'rows',items,'nextCursor',next_id);
end $$;
revoke all on function koi_private.chat_inbox_index(jsonb) from public,anon,authenticated;
grant execute on function koi_private.chat_inbox_index(jsonb) to authenticated;

create or replace function public.koi_chat_command(action text,data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$
  select case when action='inbox_index' then koi_private.chat_inbox_index(data)
    else koi_private.chat_command(action,data) end
$$;
