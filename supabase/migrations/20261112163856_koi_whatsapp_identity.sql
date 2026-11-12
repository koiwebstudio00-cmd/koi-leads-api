begin;

-- Evidence is written only from provider events and existing WhatsApp history.
create table koi_private.whatsapp_identities (
  workspace_id uuid not null,
  lead_id uuid not null,
  phone text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  primary key(workspace_id,lead_id,phone),
  foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id)
);
alter table koi_private.whatsapp_identities enable row level security;
create policy identity_owner_select on koi_private.whatsapp_identities for select to koi_campaign_owner using (true);
create policy identity_owner_insert on koi_private.whatsapp_identities for insert to koi_campaign_owner with check (true);
revoke all on koi_private.whatsapp_identities from public,anon,authenticated;
grant select,insert on koi_private.whatsapp_identities to koi_campaign_owner;

create function koi_private.contact_available(w uuid, lead uuid, number text) returns boolean
language sql stable security invoker set search_path='' as $$
  select coalesce(number ~ '^[1-9][0-9]{9,14}$'
    and (lead is null or exists (
      select 1 from public.koi_leads l where l.workspace_id=w and l.id=lead
      and l.deleted_at is null and koi_private.match_chat_lead(w,number)=l.id
    ))
    and not exists (
      select 1 from public.koi_suppressions s where s.workspace_id=w and (
        s.phone=number or s.phone=(select l.phone from public.koi_leads l where l.workspace_id=w and l.id=lead)
        or exists(select 1 from koi_private.whatsapp_identities i
          where i.workspace_id=w and i.lead_id=lead and i.phone=s.phone
          and koi_private.match_chat_lead(w,i.phone)=lead)
      )
    ),false)
$$;

create function koi_private.whatsapp_target(w uuid, lead uuid, original text) returns text
language sql stable security invoker set search_path='' as $$
  select coalesce((select min(i.phone) from koi_private.whatsapp_identities i
    where i.workspace_id=w and i.lead_id=lead and koi_private.match_chat_lead(w,i.phone)=lead
    having count(*)=1),original)
$$;

create function koi_private.remember_whatsapp_identity() returns trigger
language plpgsql security invoker set search_path='' as $$
declare c public.koi_conversations;
begin
  if new.provider_id is null or not (new.direction='in' or new.delivery in ('delivered','read')) then return new; end if;
  select * into c from public.koi_conversations where id=new.conversation_id and workspace_id=new.workspace_id;
  if c.lead_id is not null and c.phone ~ '^[1-9][0-9]{9,14}$'
    and c.peer=c.phone||'@s.whatsapp.net' and koi_private.match_chat_lead(c.workspace_id,c.phone)=c.lead_id then
    insert into koi_private.whatsapp_identities values(c.workspace_id,c.lead_id,c.phone) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger remember_whatsapp_identity after insert or update of delivery on koi_private.chat_messages
for each row execute function koi_private.remember_whatsapp_identity();

insert into koi_private.whatsapp_identities
select distinct c.workspace_id,c.lead_id,c.phone from public.koi_conversations c
join koi_private.chat_messages m on m.conversation_id=c.id and m.workspace_id=c.workspace_id
where c.lead_id is not null and c.phone ~ '^[1-9][0-9]{9,14}$' and c.peer=c.phone||'@s.whatsapp.net'
  and koi_private.match_chat_lead(c.workspace_id,c.phone)=c.lead_id
  and m.provider_id is not null and (m.direction='in' or m.delivery in ('delivered','read'))
on conflict do nothing;

revoke all on function koi_private.contact_available(uuid,uuid,text), koi_private.whatsapp_target(uuid,uuid,text),
  koi_private.remember_whatsapp_identity() from public,anon,authenticated;
grant execute on function koi_private.contact_available(uuid,uuid,text), koi_private.whatsapp_target(uuid,uuid,text),
  koi_private.remember_whatsapp_identity() to koi_campaign_owner;

-- Preserve the installed inbox version while replacing its shared send guard.
do $migration$
declare definition text; previous text; target regprocedure;
begin
  foreach target in array array['koi_private.chat_command(text,jsonb)'::regprocedure,'koi_private.chat_machine(text,jsonb)'::regprocedure] loop
    select pg_get_functiondef(target) into definition;
    previous:=definition;
    definition:=regexp_replace(definition,
      'c.phone is null or exists\(select 1 from public.koi_suppressions where workspace_id=w and phone=c.phone\)\s+or \(c.lead_id is not null and not exists\(select 1 from public.koi_leads where id=c.lead_id and workspace_id=w and deleted_at is null and phone=c.phone\)\)',
      'not koi_private.contact_available(w,c.lead_id,c.phone)','g');
    if definition=previous then raise exception 'Expected contact guard missing in %',target; end if;
    if target='koi_private.chat_command(text,jsonb)'::regprocedure then
      definition:=replace(definition, 'l.phone||''@s.whatsapp.net''', 'koi_private.whatsapp_target(w,l.id,l.phone)||''@s.whatsapp.net''');
      definition:=replace(definition, 'l.phone,l.name,l.id,l.assigned_to)', 'koi_private.whatsapp_target(w,l.id,l.phone),l.name,l.id,l.assigned_to)');
    else
      definition:=replace(definition,
        'set status=''failed'',reason=''contact_unavailable'',lease_token=null,lease_until=null where id=m.id;',
        'set status=''failed'',reason=''contact_unavailable'',lease_token=null,lease_until=null where id=m.id;
      perform koi_private.dispatch_release(w,m.instance,m.id,m.lease_token);');
    end if;
    execute definition;
  end loop;
end $migration$;

-- Campaign creation and dispatch use the same identity and opt-out decisions.
do $migration$
declare definition text;
begin
  select pg_get_functiondef('koi_private.campaign_candidates(uuid)'::regprocedure) into definition;
  definition:=replace(definition,'select l.id,l.phone,l.name', 'select l.id,koi_private.whatsapp_target(l.workspace_id,l.id,l.phone),l.name');
  definition:=replace(definition,'exists(select 1 from public.koi_suppressions s where s.workspace_id=l.workspace_id and s.phone=l.phone)',
    'not koi_private.contact_available(l.workspace_id,l.id,koi_private.whatsapp_target(l.workspace_id,l.id,l.phone))');
  execute definition;
  select pg_get_functiondef('koi_private.worker_command(text,jsonb)'::regprocedure) into definition;
  definition:=replace(definition,'exists(select 1 from public.koi_suppressions where workspace_id=w and phone=r.phone)',
    'not koi_private.contact_available(w,r.lead_id,r.phone)');
  execute definition;
end $migration$;
commit;
