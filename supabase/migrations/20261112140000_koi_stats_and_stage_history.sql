-- Historial de cambios de etapa y estadísticas por periodo.
-- Los cambios de etapa desde ahora quedan registrados; no se reconstruye el pasado.

create table public.koi_lead_stage_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.koi_workspaces(id),
  lead_id uuid not null,
  from_stage text not null check (from_stage in ('new','contacted','replied','interested','proposal','won','lost')),
  to_stage text not null check (to_stage in ('new','contacted','replied','interested','proposal','won','lost')),
  changed_at timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.koi_leads(workspace_id, id)
);
create index koi_lead_stage_events_period on public.koi_lead_stage_events(workspace_id, changed_at);

alter table public.koi_lead_stage_events enable row level security;
create policy stage_events_member_read on public.koi_lead_stage_events for select to authenticated
  using (exists (select 1 from public.koi_workspace_members m where m.workspace_id = koi_lead_stage_events.workspace_id and m.user_id = (select auth.uid())));

create or replace function koi_private.lead_stage_history() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.koi_lead_stage_events(workspace_id, lead_id, from_stage, to_stage) values (new.workspace_id, new.id, old.stage, new.stage);
  end if;
  return new;
end $$;

create trigger koi_lead_stage_history after update of stage on public.koi_leads
  for each row execute function koi_private.lead_stage_history();

create or replace function public.koi_stats_command(p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare
  w uuid; f timestamptz; t timestamptz; tz constant text := 'America/Argentina/Tucuman'; result jsonb;
begin
  select workspace_id into w from public.koi_workspace_members where user_id=auth.uid();
  if w is null then raise exception 'Not authorized' using errcode='42501'; end if;
  f := (p_data->>'from')::timestamptz; t := (p_data->>'to')::timestamptz;
  if f is null or t is null or t <= f or t - f > interval '400 days' then raise exception 'Invalid period' using errcode='22023'; end if;

  with
  contacted_leads as (
    select c.lead_id, m.sent_at as at_ts
      from koi_private.chat_messages m join public.koi_conversations c on c.id = m.conversation_id
     where m.workspace_id = w and m.direction = 'out' and m.status = 'accepted' and m.sent_at >= f and m.sent_at < t and c.lead_id is not null
    union all
    select r.lead_id, r.updated_at from public.koi_campaign_recipients r
     where r.workspace_id = w and r.status = 'accepted' and r.updated_at >= f and r.updated_at < t
  ),
  stage_moves as (
    select lead_id, to_stage, changed_at as at_ts from public.koi_lead_stage_events
     where workspace_id = w and changed_at >= f and changed_at < t
  ),
  failures as (
    select m.sent_at as at_ts from koi_private.chat_messages m
     where m.workspace_id = w and m.direction = 'out' and m.status = 'failed' and m.sent_at >= f and m.sent_at < t
    union all
    select r.updated_at from public.koi_campaign_recipients r
     where r.workspace_id = w and r.status = 'failed' and r.updated_at >= f and r.updated_at < t
  ),
  days as (
    select d::date as day
      from generate_series((f at time zone tz)::date, ((t - interval '1 microsecond') at time zone tz)::date, interval '1 day') d
  )
  select jsonb_build_object(
    'timezone', tz,
    'period', jsonb_build_object('from', f, 'to', t),
    'kpis', jsonb_build_object(
      'contacted', (select count(distinct lead_id) from contacted_leads),
      'interested', (select count(distinct lead_id) from stage_moves where to_stage = 'interested'),
      'won', (select count(distinct lead_id) from stage_moves where to_stage = 'won'),
      'interestedOrWon', (select count(distinct lead_id) from stage_moves where to_stage in ('interested','won')),
      'lost', (select count(distinct lead_id) from stage_moves where to_stage = 'lost'),
      'newLeads', (select count(*) from public.koi_leads where workspace_id = w and deleted_at is null and created_at >= f and created_at < t),
      'messagesSent', (select count(*) from koi_private.chat_messages where workspace_id = w and direction = 'out' and sent_at >= f and sent_at < t),
      'messagesReceived', (select count(*) from koi_private.chat_messages where workspace_id = w and direction = 'in' and sent_at >= f and sent_at < t),
      'errors', (select count(*) from failures),
      'activeCampaigns', (select count(*) from public.koi_campaigns where workspace_id = w and status in ('scheduled','running','paused'))
    ),
    'campaignRecipients', coalesce((select jsonb_object_agg(x.status, x.n) from (
      select r.status, count(*) n from public.koi_campaign_recipients r
       where r.workspace_id = w and r.updated_at >= f and r.updated_at < t group by r.status) x), '{}'),
    'funnel', coalesce((select jsonb_object_agg(x.stage, x.n) from (
      select l.stage, count(*) n from public.koi_leads l where l.workspace_id = w and l.deleted_at is null group by l.stage) x), '{}'),
    'daily', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from (
      select d.day,
        (select count(distinct lead_id) from contacted_leads c where (c.at_ts at time zone tz)::date = d.day) as contacted,
        (select count(distinct lead_id) from stage_moves s where s.to_stage in ('interested','won') and (s.at_ts at time zone tz)::date = d.day) as "interestedOrWon",
        (select count(distinct lead_id) from stage_moves s where s.to_stage = 'lost' and (s.at_ts at time zone tz)::date = d.day) as lost,
        (select count(*) from failures x where (x.at_ts at time zone tz)::date = d.day) as errors
      from days d) x), '[]')
  ) into result;
  return result;
end $$;

revoke all on function public.koi_stats_command(jsonb) from public;
grant execute on function public.koi_stats_command(jsonb) to authenticated;
