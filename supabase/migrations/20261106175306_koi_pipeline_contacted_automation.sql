begin;
-- The existing worker owner has no login and remains subject to RLS.
grant update(stage) on public.koi_leads to koi_campaign_owner;
create policy campaign_contacted_transition on public.koi_leads for update to koi_campaign_owner
 using (stage='new' and exists(select 1 from koi_private.machine_bindings b where b.role_name=session_user and b.workspace_id=koi_leads.workspace_id and b.kind='worker'))
 with check (stage='contacted' and exists(select 1 from public.koi_campaign_recipients r where r.workspace_id=koi_leads.workspace_id and r.lead_id=koi_leads.id and r.status='accepted'));
create function koi_private.contact_lead_on_accepted() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 update public.koi_leads set stage='contacted'
 where id=new.lead_id and workspace_id=new.workspace_id and stage='new';
 return new;
end $$;
revoke all on function koi_private.contact_lead_on_accepted() from public,anon,authenticated;
create trigger koi_recipient_contacted
 after update of status on public.koi_campaign_recipients
 for each row when (new.status='accepted' and old.status is distinct from new.status)
 execute function koi_private.contact_lead_on_accepted();

-- Reconcile existing accepted sends without downgrading commercial progress.
update public.koi_leads l set stage='contacted'
 where l.stage='new' and exists(
 select 1 from public.koi_campaign_recipients r
 where r.workspace_id=l.workspace_id and r.lead_id=l.id and r.status='accepted'
 );
commit;
