begin;
create table public.koi_saved_messages (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.koi_workspaces(id) on delete cascade,
 title text not null check(char_length(btrim(title)) between 1 and 120),
 category text not null check(char_length(btrim(category)) between 1 and 40),
 body text not null check(char_length(btrim(body)) between 1 and 4000),
 archived boolean not null default false,
 revision integer not null default 0,
 created_by uuid default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 request_id uuid not null, unique(workspace_id,request_id)
);
create index koi_saved_messages_listing on public.koi_saved_messages(workspace_id,archived,updated_at desc,id);
alter table public.koi_saved_messages enable row level security;
revoke all on public.koi_saved_messages from anon,authenticated;
grant select on public.koi_saved_messages to authenticated;
grant insert(workspace_id,title,category,body,request_id) on public.koi_saved_messages to authenticated;
grant update(title,category,body,archived) on public.koi_saved_messages to authenticated;
create policy member_read on public.koi_saved_messages for select to authenticated using(exists(select 1 from public.koi_workspace_members where user_id=(select auth.uid()) and workspace_id=koi_saved_messages.workspace_id));
create policy member_create on public.koi_saved_messages for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.koi_workspace_members where user_id=(select auth.uid()) and workspace_id=koi_saved_messages.workspace_id));
create policy member_update on public.koi_saved_messages for update to authenticated using(exists(select 1 from public.koi_workspace_members where user_id=(select auth.uid()) and workspace_id=koi_saved_messages.workspace_id)) with check(exists(select 1 from public.koi_workspace_members where user_id=(select auth.uid()) and workspace_id=koi_saved_messages.workspace_id));
create function koi_private.saved_message_revision() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.revision:=old.revision+1; new.updated_at:=now(); return new; end $$;
revoke all on function koi_private.saved_message_revision() from public,anon,authenticated;
create trigger saved_message_revision before update on public.koi_saved_messages for each row execute function koi_private.saved_message_revision();
create function koi_private.saved_message_command(action text,data jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare w uuid; t public.koi_saved_messages; n integer; result jsonb; q text:=lower(coalesce(data->>'search','')); cat text:=coalesce(data->>'category',''); off_n integer:=greatest(0,least(coalesce((data->>'page')::integer,1),100000)-1)*30;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
 if w is null then raise exception 'Not authorized' using errcode='42501'; end if;
 if action='messages' then
  select count(*) into n from public.koi_saved_messages where workspace_id=w and archived=coalesce((data->>'archived')::boolean,false) and (cat='' or category=cat) and (q='' or strpos(lower(title||' '||body||' '||category),q)>0);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.updated_at desc,r.id),'[]') into result from (select * from public.koi_saved_messages where workspace_id=w and archived=coalesce((data->>'archived')::boolean,false) and (cat='' or category=cat) and (q='' or strpos(lower(title||' '||body||' '||category),q)>0) order by updated_at desc,id limit 30 offset off_n) r;
  return jsonb_build_object('messages',result,'total',n,'categories',coalesce((select jsonb_agg(category order by category) from (select distinct category from public.koi_saved_messages where workspace_id=w) c),'[]'));
 elsif action='message_create' then
  insert into public.koi_saved_messages(workspace_id,title,category,body,request_id) values(w,btrim(data->>'title'),btrim(data->>'category'),btrim(data->>'body'),(data->>'key')::uuid) on conflict(workspace_id,request_id) do nothing;
  select * into t from public.koi_saved_messages where workspace_id=w and request_id=(data->>'key')::uuid;
  if t.title<>btrim(data->>'title') or t.category<>btrim(data->>'category') or t.body<>btrim(data->>'body') or t.created_by<>auth.uid() then raise exception 'Request conflict' using errcode='PT409'; end if;
  return to_jsonb(t);
 elsif action='message_update' then
  select * into t from public.koi_saved_messages where workspace_id=w and id=(data->>'id')::uuid;
  if not found then raise exception 'Message not found' using errcode='PT404'; end if;
  update public.koi_saved_messages set title=case when data?'title' then btrim(data->>'title') else title end, category=case when data?'category' then btrim(data->>'category') else category end, body=case when data?'body' then btrim(data->>'body') else body end, archived=case when data?'archived' then (data->>'archived')::boolean else archived end where id=t.id and workspace_id=w and revision=(data->>'revision')::integer returning * into t;
  if not found then raise exception 'Stale message' using errcode='PT409'; end if;
  return to_jsonb(t);
 end if;
 raise exception 'Unknown action' using errcode='22023';
end $$;
revoke all on function koi_private.saved_message_command(text,jsonb) from public,anon;
grant execute on function koi_private.saved_message_command(text,jsonb) to authenticated;

create or replace function public.koi_crm_command(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security invoker set search_path='' as $$
declare w uuid; l public.koi_leads; result jsonb; cols jsonb:='[]'; s text; n integer; offset_n integer:=greatest(0,least(coalesce((p_data->>'page')::integer,1),100000)-1)*30; note public.koi_lead_notes;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
 if w is null then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_action in ('messages','message_create','message_update') then return koi_private.saved_message_command(p_action,p_data); end if;
 if p_action in ('tasks','task_create','task_update') then return koi_private.followup_command(p_action,p_data); end if;
 if p_action in ('create','bulk') then return public.koi_manage_leads(p_action,p_data);
 elsif p_action='options' then
  return jsonb_build_object('members',koi_private.crm_members(),
   'lists',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.koi_lead_lists where workspace_id=w),'[]'),
   'tags',coalesce((select jsonb_agg(t order by t) from (select distinct unnest(tags) t from public.koi_leads where workspace_id=w) x),'[]'));
 elsif p_action='summary' then
 return jsonb_build_object('leads',(select count(*) from public.koi_leads where workspace_id=w and deleted_at is null),'contacted',(select count(*) from public.koi_leads contact where contact.workspace_id=w and contact.deleted_at is null and koi_private.last_contact(w,contact.id) is not null),'campaigns',(select coalesce(jsonb_object_agg(c.status,c.n),'{}') from (select status,count(*) n from public.koi_campaigns where workspace_id=w group by status) c));
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
   'lastContactAt',koi_private.last_contact(w,l.id));
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

commit;
