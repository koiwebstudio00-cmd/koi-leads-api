begin;

-- A single first paid touch per WhatsApp conversation. Keep provider identifiers
-- private. An undated historical referral never becomes a consultation "today".
create table koi_private.stats_first_touch (
  workspace_id uuid not null,
  account_id uuid not null,
  conversation_id uuid primary key,
  occurred_at timestamptz,
  click_id text,
  ad_id text,
  ad_name text,
  campaign_id text,
  campaign_name text,
  ad_set_id text,
  ad_account_id text,
  foreign key (workspace_id,account_id,conversation_id)
    references public.koi_inbox_conversations(workspace_id,account_id,id)
);
create index stats_first_touch_period on koi_private.stats_first_touch(workspace_id,occurred_at);

create function koi_private.stats_capture_touch(w uuid, a uuid, c uuid, m jsonb, sent timestamptz)
returns void language plpgsql set search_path='' as $$
declare
  ad jsonb := coalesce(nullif(m->'ad','null'), m->'adAttribution');
  ref jsonb := m->'referral';
  click text := left(coalesce(nullif(ref->>'ctwa_clid',''),nullif(m->>'ctwa_clid','')),500);
  adid text := left(coalesce(nullif(ad->>'adId',''),
    case when ref->>'source_type'='ad' then nullif(ref->>'source_id','') end,
    case when m->>'ctwa_source_type'='ad' then nullif(m->>'ctwa_source_id','') end),200);
  moment timestamptz := sent;
  ts text := m->>'ctwa_captured_at';
  prev koi_private.stats_first_touch;
  compatible boolean;
begin
  if click is null and adid is null then return; end if;
  if moment is null and ts ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' and pg_input_is_valid(ts,'timestamp with time zone') then
    moment := ts::timestamptz;
  end if;
  -- The conversation lock also serializes concurrent webhook/history inserts.
  perform 1 from public.koi_inbox_conversations
    where workspace_id=w and account_id=a and id=c and channel='whatsapp' for update;
  if not found then return; end if;
  select * into prev from koi_private.stats_first_touch where conversation_id=c;
  if found then
    compatible := (prev.click_id is null or click is null or prev.click_id=click)
      and (prev.ad_id is null or adid is null or prev.ad_id=adid);
    if not compatible and (moment is null or (prev.occurred_at is not null and moment >= prev.occurred_at)) then
      return;
    end if;
    if compatible then
      update koi_private.stats_first_touch set
        occurred_at=least(occurred_at,moment), click_id=coalesce(click_id,click),
        ad_id=coalesce(ad_id,adid), ad_name=coalesce(nullif(left(ad->>'name',250),''),ad_name),
        campaign_id=coalesce(campaign_id,nullif(left(ad->>'campaignId',200),'')),
        campaign_name=coalesce(nullif(left(ad->>'campaignName',250),''),campaign_name),
        ad_set_id=coalesce(ad_set_id,nullif(left(ad->>'adSetId',200),'')),
        ad_account_id=coalesce(ad_account_id,nullif(left(ad->>'adAccountId',200),''))
        where conversation_id=c;
      return;
    end if;
  end if;
  insert into koi_private.stats_first_touch as t
    (workspace_id,account_id,conversation_id,occurred_at,click_id,ad_id,ad_name,campaign_id,campaign_name,ad_set_id,ad_account_id)
    values(w,a,c,moment,click,adid,nullif(left(ad->>'name',250),''),
      nullif(left(ad->>'campaignId',200),''),nullif(left(ad->>'campaignName',250),''),
      nullif(left(ad->>'adSetId',200),''),nullif(left(ad->>'adAccountId',200),''))
    on conflict(conversation_id) do update set occurred_at=excluded.occurred_at,click_id=excluded.click_id,
      ad_id=excluded.ad_id,ad_name=excluded.ad_name,campaign_id=excluded.campaign_id,campaign_name=excluded.campaign_name,
      ad_set_id=excluded.ad_set_id,ad_account_id=excluded.ad_account_id;
end $$;

create function koi_private.stats_capture_event(e koi_private.inbox_events)
returns void language plpgsql set search_path='' as $$
declare msg record; meta jsonb;
begin
  if e.kind <> 'message.received' then return; end if;
  meta := coalesce(nullif(e.payload#>'{message,metadata}','null'),'{}'::jsonb)
    || coalesce(nullif(e.payload->'metadata','null'),'{}'::jsonb);
  if not (meta ?| array['referral','ad','adAttribution','ctwa_clid','ctwa_source_id']) then return; end if;
  select conversation_id,sent_at into msg from koi_private.inbox_messages
    where workspace_id=e.workspace_id and account_id=e.account_id and direction='in'
      and external_id=e.payload#>>'{message,platformMessageId}';
  if found then perform koi_private.stats_capture_touch(e.workspace_id,e.account_id,msg.conversation_id,meta,msg.sent_at); end if;
end $$;

create function koi_private.stats_event_trigger() returns trigger language plpgsql set search_path='' as $$
begin perform koi_private.stats_capture_event(new); return new; end $$;
create function koi_private.stats_history_trigger() returns trigger language plpgsql set search_path='' as $$
begin perform koi_private.stats_capture_touch(new.workspace_id,new.account_id,new.conversation_id,new.metadata,null); return new; end $$;

create trigger stats_event after insert on koi_private.inbox_events for each row
  when (new.kind='message.received') execute function koi_private.stats_event_trigger();
create trigger stats_history after insert or update of metadata on koi_private.inbox_history_context
  for each row execute function koi_private.stats_history_trigger();

do $$
declare e koi_private.inbox_events; h koi_private.inbox_history_context;
begin
  for e in select * from koi_private.inbox_events where kind='message.received' order by received_at,id loop
    perform koi_private.stats_capture_event(e);
  end loop;
  for h in select * from koi_private.inbox_history_context loop
    perform koi_private.stats_capture_touch(h.workspace_id,h.account_id,h.conversation_id,h.metadata,null);
  end loop;
end $$;

-- Provider snapshots contain business statistics only. Each entry belongs to the
-- workspace/profile, selected dates and connected accounts used for that read.
create table koi_private.stats_provider_cache (
  workspace_id uuid not null references public.koi_workspaces(id),
  profile_id text not null, cache_key text not null, synced_at timestamptz not null,
  data jsonb not null, primary key(workspace_id,profile_id,cache_key)
);
-- Durable ad/day values are replaced when Meta revises a closed day. A missing
-- daily breakdown is left missing, rather than spreading a period's spend.
create table koi_private.stats_ad_spend (
  workspace_id uuid not null references public.koi_workspaces(id),
  profile_id text not null, ad_account_id text not null, campaign_id text not null,
  ad_id text not null, day date not null, currency text not null,
  spend numeric not null check (spend>=0), synced_at timestamptz not null,
  primary key(workspace_id,profile_id,ad_account_id,ad_id,day,currency)
);
alter table koi_private.stats_ad_spend enable row level security;
revoke all on koi_private.stats_ad_spend from public,anon,authenticated;
alter table koi_private.stats_first_touch enable row level security;
alter table koi_private.stats_provider_cache enable row level security;
revoke all on koi_private.stats_first_touch,koi_private.stats_provider_cache from public,anon,authenticated;

create function koi_private.channel_statistics(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  b koi_private.inbox_bindings; start_at timestamptz; end_at timestamptz; k text:=p->>'key';
  result jsonb; counts jsonb; since_date timestamptz; missing bigint;
begin
  select * into b from koi_private.inbox_bindings where role_name=session_user and kind='gateway';
  if b.workspace_id is null or b.workspace_id is distinct from (p->>'workspaceId')::uuid
    or b.profile_id is distinct from p->>'profileId' or not exists (
    select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=(p->>'actorId')::uuid and role in ('admin','operator')
  ) then raise exception 'Statistics scope denied' using errcode='42501'; end if;
  if action='accounts' then
    select coalesce(jsonb_agg(jsonb_build_object('id',external_id,'name',label,'address',address,'channel',channel,'state',state)
      order by created_at,id),'[]') into result from public.koi_inbox_accounts where workspace_id=b.workspace_id;
    return result;
  elsif action='attribution' then
    start_at:=(p->>'from')::timestamptz; end_at:=(p->>'to')::timestamptz;
    if start_at is null or end_at is null or end_at<=start_at then raise exception 'Invalid period' using errcode='22023'; end if;
    with first_inbound as (
      select m.conversation_id,min(m.sent_at) as first_at from koi_private.inbox_messages m
      join public.koi_inbox_conversations c on c.id=m.conversation_id and c.channel='whatsapp'
      where m.workspace_id=b.workspace_id and m.direction='in' group by m.conversation_id
    )
    select min(i.first_at), count(*) filter(where t.conversation_id is null and i.first_at>=start_at and i.first_at<end_at)
      into since_date,missing from first_inbound i left join koi_private.stats_first_touch t using(conversation_id);
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into counts from (
      select t.ad_id as "adId", max(t.ad_name) as "adName", t.campaign_id as "campaignId", max(t.campaign_name) as "campaignName",count(*)::int as consultations
      from koi_private.stats_first_touch t where t.workspace_id=b.workspace_id
        and t.occurred_at>=start_at and t.occurred_at<end_at
      group by t.ad_id,t.campaign_id
    ) x;
    return jsonb_build_object('rows',counts,'unattributed',missing,'coverageFrom',since_date,
      'undated',(select count(*) from koi_private.stats_first_touch where workspace_id=b.workspace_id and occurred_at is null),
      'knownAdIds',(select coalesce(jsonb_agg(distinct ad_id),'[]') from koi_private.stats_first_touch where workspace_id=b.workspace_id and ad_id is not null));
  elsif action in ('load','save') then
    if k is null or length(k) not between 1 and 240 then raise exception 'Invalid cache key' using errcode='22023'; end if;
    if action='save' then
      if jsonb_typeof(p->'data') is distinct from 'object' then raise exception 'Invalid snapshot' using errcode='22023'; end if;
      if not coalesce((p->>'keepPrevious')::boolean,false) then
        insert into koi_private.stats_provider_cache as c values(b.workspace_id,b.profile_id,k,(p->>'syncedAt')::timestamptz,p->'data')
          on conflict(workspace_id,profile_id,cache_key) do update set synced_at=excluded.synced_at,data=excluded.data
          where excluded.synced_at>=c.synced_at;
      end if;
      if p->>'channel'='whatsapp' then
        insert into koi_private.stats_ad_spend as s(workspace_id,profile_id,ad_account_id,campaign_id,ad_id,day,currency,spend,synced_at)
        select b.workspace_id,b.profile_id,r."adAccountId",r."campaignId",r."adId",d.date,r.currency,d.spend,(p->>'syncedAt')::timestamptz
        from jsonb_to_recordset(p#>'{data,rows}') as r("adAccountId" text,"adId" text,"campaignId" text,currency text,daily jsonb)
        cross join lateral jsonb_to_recordset(nullif(r.daily,'null'::jsonb)) as d(date date,spend numeric)
        where d.date is not null and d.spend>=0 and nullif(r.currency,'') is not null
        on conflict(workspace_id,profile_id,ad_account_id,ad_id,day,currency)
        do update set spend=excluded.spend,campaign_id=excluded.campaign_id,synced_at=excluded.synced_at
          where excluded.synced_at>=s.synced_at;
      end if;
      delete from koi_private.stats_provider_cache where workspace_id=b.workspace_id and profile_id=b.profile_id and synced_at<now()-interval '90 days';
      return '{}';
    end if;
    select jsonb_build_object('at',synced_at,'data',data) into result from koi_private.stats_provider_cache
      where workspace_id=b.workspace_id and profile_id=b.profile_id and cache_key=k;
    return result;
  end if;
  raise exception 'Unknown statistics action' using errcode='22023';
end $$;
revoke all on function koi_private.stats_capture_touch(uuid,uuid,uuid,jsonb,timestamptz),
  koi_private.stats_capture_event(koi_private.inbox_events), koi_private.stats_event_trigger(), koi_private.stats_history_trigger(),
  koi_private.channel_statistics(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.channel_statistics(text,jsonb) to koi_inbox_gateway;
commit;
