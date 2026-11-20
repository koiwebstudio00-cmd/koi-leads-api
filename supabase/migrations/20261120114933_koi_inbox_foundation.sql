begin;

-- Instagram contacts may not have a phone. Existing phone-based flows stay strict.
alter table public.koi_leads alter column phone drop not null;
create function koi_private.preserve_contact_phone() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if old.phone is not null and new.phone is null then
    raise exception 'An existing phone cannot be removed' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function koi_private.preserve_contact_phone() from public,anon,authenticated;
create trigger preserve_contact_phone before update of phone on public.koi_leads
for each row execute function koi_private.preserve_contact_phone();

-- Retain the installed identity/opt-out logic and exclude phone-less contacts from
-- WhatsApp campaign snapshots (whose phone column is intentionally NOT NULL).
do $migration$
declare definition text; previous text;
begin
  select pg_get_functiondef('koi_private.campaign_candidates(uuid)'::regprocedure) into definition;
  previous := definition;
  definition := replace(definition,'where l.deleted_at is null and c.id=p_id',
    'where l.phone is not null and l.deleted_at is null and c.id=p_id');
  if definition=previous then raise exception 'Expected campaign phone guard location missing'; end if;
  execute definition;
  select pg_get_functiondef('public.koi_campaign_recipient_picker(uuid,text,text,text,integer,uuid[])'::regprocedure) into definition;
  previous := definition;
  definition := replace(definition,'where m.workspace_id = w and m.list_id = p_list',
    'where l.phone is not null and m.workspace_id = w and m.list_id = p_list');
  if definition=previous then raise exception 'Expected recipient phone guard location missing'; end if;
  execute definition;
  select pg_get_functiondef('koi_private.chat_command(text,jsonb)'::regprocedure) into definition;
  previous := definition;
  definition := replace(definition,
    '-- La fila se crea recién al enviar: abrir un borrador no deja chats vacíos en la bandeja.',
    'if l.phone is null then raise exception ''Phone required for EvoAPI'' using errcode=''22023''; end if;
    -- La fila se crea recién al enviar: abrir un borrador no deja chats vacíos en la bandeja.');
  if definition=previous then raise exception 'Expected EvoAPI send guard location missing'; end if;
  execute definition;
end $migration$;

create table public.koi_inbox_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.koi_workspaces(id),
  provider text not null default 'zernio' check(provider='zernio'),
  channel text not null check(channel in ('whatsapp','instagram')),
  external_id text not null check(char_length(btrim(external_id)) between 1 and 200),
  label text not null check(char_length(btrim(label)) between 1 and 100),
  address text check(char_length(address)<=250),
  state text not null default 'pending' check(state in ('pending','connected','disconnected','error')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,id), unique(workspace_id,id,channel),
  unique(provider,external_id),
  foreign key(workspace_id,created_by) references public.koi_workspace_members(workspace_id,user_id)
);
create index koi_inbox_accounts_creator on public.koi_inbox_accounts(workspace_id,created_by);

create table koi_private.inbox_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id uuid not null,
  channel text not null,
  lead_id uuid not null,
  external_id text not null check(char_length(btrim(external_id)) between 1 and 200),
  display_name text not null default '' check(char_length(display_name)<=250),
  username text check(char_length(username)<=250),
  created_at timestamptz not null default now(),
  unique(workspace_id,account_id,external_id),
  unique(workspace_id,account_id,id,lead_id),
  foreign key(workspace_id,account_id,channel) references public.koi_inbox_accounts(workspace_id,id,channel),
  foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id)
);
create index koi_inbox_identities_lead on koi_private.inbox_identities(workspace_id,lead_id);

create table public.koi_inbox_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id uuid not null,
  channel text not null,
  external_id text not null check(char_length(btrim(external_id)) between 1 and 200),
  identity_id uuid not null,
  lead_id uuid not null,
  assigned_to uuid,
  archived boolean not null default false,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,account_id,external_id),
  unique(workspace_id,account_id,id), unique(workspace_id,id),
  foreign key(workspace_id,account_id,channel) references public.koi_inbox_accounts(workspace_id,id,channel),
  foreign key(workspace_id,account_id,identity_id,lead_id) references koi_private.inbox_identities(workspace_id,account_id,id,lead_id),
  foreign key(workspace_id,lead_id) references public.koi_leads(workspace_id,id),
  foreign key(workspace_id,assigned_to) references public.koi_workspace_members(workspace_id,user_id)
);
create index koi_inbox_conversations_recent on public.koi_inbox_conversations(workspace_id,account_id,updated_at desc,id);
create index koi_inbox_conversations_lead on public.koi_inbox_conversations(workspace_id,lead_id);
create index koi_inbox_conversations_owner on public.koi_inbox_conversations(workspace_id,assigned_to);
create index koi_inbox_conversations_identity on public.koi_inbox_conversations(workspace_id,account_id,identity_id,lead_id);

create table koi_private.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  workspace_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  external_id text check(char_length(btrim(external_id)) between 1 and 200),
  direction text not null check(direction in ('in','out')),
  body text not null default '' check(char_length(body)<=10000),
  sent_at timestamptz not null,
  historical boolean not null default false,
  actor_id uuid,
  status text not null check(status in ('received','queued','sending','accepted','failed','unknown','closed')),
  delivery text check(delivery in ('sent','delivered','read','error')),
  created_at timestamptz not null default now(),
  unique(workspace_id,account_id,external_id),
  unique(workspace_id,account_id,conversation_id,id),
  unique(workspace_id,conversation_id,id),
  check((direction='in' and status='received' and actor_id is null) or (direction='out' and status<>'received')),
  foreign key(workspace_id,account_id,conversation_id) references public.koi_inbox_conversations(workspace_id,account_id,id),
  foreign key(workspace_id,actor_id) references public.koi_workspace_members(workspace_id,user_id)
);
create index koi_inbox_messages_history on koi_private.inbox_messages(workspace_id,conversation_id,sent_at desc,id);
create index koi_inbox_messages_actor on koi_private.inbox_messages(workspace_id,actor_id);

create table koi_private.inbox_reads (
  workspace_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  through_message_id uuid,
  updated_at timestamptz not null default now(),
  primary key(workspace_id,conversation_id,user_id),
  foreign key(workspace_id,conversation_id) references public.koi_inbox_conversations(workspace_id,id),
  foreign key(workspace_id,conversation_id,through_message_id) references koi_private.inbox_messages(workspace_id,conversation_id,id),
  foreign key(workspace_id,user_id) references public.koi_workspace_members(workspace_id,user_id)
);
create index koi_inbox_reads_user on koi_private.inbox_reads(workspace_id,user_id);
create index koi_inbox_reads_message on koi_private.inbox_reads(workspace_id,conversation_id,through_message_id);

create table koi_private.inbox_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id uuid not null,
  external_id text not null check(char_length(btrim(external_id)) between 1 and 200),
  kind text not null check(char_length(kind) between 1 and 100),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=1048576),
  status text not null default 'pending' check(status in ('pending','processing','processed','failed')),
  attempts integer not null default 0 check(attempts>=0),
  retry_at timestamptz not null default now(),
  processed_at timestamptz,
  error_code text check(char_length(error_code)<=100),
  received_at timestamptz not null default now(),
  unique(workspace_id,account_id,external_id),
  foreign key(workspace_id,account_id) references public.koi_inbox_accounts(workspace_id,id)
);
create index koi_inbox_events_pending on koi_private.inbox_events(workspace_id,retry_at,id) where status in ('pending','failed');

create table koi_private.inbox_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  message_id uuid not null,
  actor_id uuid not null,
  request_id uuid not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'queued' check(status in ('queued','leased','sending','accepted','failed','unknown','closed')),
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz not null default now(),
  reason text check(char_length(reason)<=100),
  created_at timestamptz not null default now(),
  unique(workspace_id,actor_id,request_id), unique(message_id),
  check((lease_token is null)=(lease_until is null)),
  check(status not in ('leased','sending') or lease_token is not null),
  foreign key(workspace_id,account_id,conversation_id,message_id) references koi_private.inbox_messages(workspace_id,account_id,conversation_id,id),
  foreign key(workspace_id,actor_id) references public.koi_workspace_members(workspace_id,user_id)
);
create index koi_inbox_outbox_message on koi_private.inbox_outbox(workspace_id,account_id,conversation_id,message_id);
create index koi_inbox_outbox_pending on koi_private.inbox_outbox(workspace_id,retry_at,id) where status in ('queued','leased','sending','unknown');
create unique index koi_inbox_one_dispatch on koi_private.inbox_outbox(conversation_id) where status in ('leased','sending','unknown');

create table koi_private.inbox_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  conversation_id uuid not null,
  message_id uuid,
  created_by uuid,
  object_key text not null unique check(char_length(object_key) between 1 and 1000),
  kind text not null check(kind in ('image','video','audio','document')),
  name text not null check(char_length(name)<=250),
  mime text not null check(char_length(mime) between 1 and 100),
  bytes bigint not null check(bytes>0),
  state text not null default 'pending' check(state in ('pending','ready','failed')),
  created_at timestamptz not null default now(),
  foreign key(workspace_id,conversation_id) references public.koi_inbox_conversations(workspace_id,id),
  foreign key(workspace_id,conversation_id,message_id) references koi_private.inbox_messages(workspace_id,conversation_id,id),
  foreign key(workspace_id,created_by) references public.koi_workspace_members(workspace_id,user_id)
);
create index koi_inbox_files_message on koi_private.inbox_files(workspace_id,conversation_id,message_id);
create index koi_inbox_files_creator on koi_private.inbox_files(workspace_id,created_by);

create table koi_private.inbox_attribution (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  event_external_id text not null,
  metadata jsonb not null check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=100000),
  captured_at timestamptz not null default now(),
  unique(workspace_id,account_id,conversation_id,event_external_id),
  foreign key(workspace_id,account_id,conversation_id) references public.koi_inbox_conversations(workspace_id,account_id,id),
  foreign key(workspace_id,account_id,event_external_id) references koi_private.inbox_events(workspace_id,account_id,external_id)
);
create index koi_inbox_attribution_event on koi_private.inbox_attribution(workspace_id,account_id,event_external_id);

-- Public summaries are read-only to members. Provider data, outbox and raw events
-- are private: no frontend writes, no grants to existing EvoAPI machine roles.
alter table public.koi_inbox_accounts enable row level security;
alter table public.koi_inbox_conversations enable row level security;
revoke all on public.koi_inbox_accounts,public.koi_inbox_conversations from public,anon,authenticated;
grant select on public.koi_inbox_accounts,public.koi_inbox_conversations to authenticated;
create policy inbox_accounts_member on public.koi_inbox_accounts for select to authenticated
using (workspace_id in (select workspace_id from public.koi_workspace_members where user_id=(select auth.uid())));
create policy inbox_conversations_member on public.koi_inbox_conversations for select to authenticated
using (workspace_id in (select workspace_id from public.koi_workspace_members where user_id=(select auth.uid())));
do $security$
declare name text;
begin
  foreach name in array array['inbox_identities','inbox_messages','inbox_reads','inbox_events','inbox_outbox','inbox_files','inbox_attribution'] loop
    execute format('alter table koi_private.%I enable row level security',name);
    execute format('revoke all on koi_private.%I from public,anon,authenticated',name);
  end loop;
end $security$;

create function koi_private.inbox_reply_window(last_inbound timestamptz, evaluated_at timestamptz, account_state text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('canReply',reason='open','reason',reason,
    'expiresAt',case when last_inbound is null or not isfinite(last_inbound) or last_inbound>evaluated_at then null
      else last_inbound+interval '24 hours' end,'evaluatedAt',evaluated_at)
  from (select case when evaluated_at is null or not isfinite(evaluated_at) then 'invalid_inbound'
    when account_state is distinct from 'connected' then 'disconnected'
    when last_inbound is null then 'missing_inbound'
    when not isfinite(last_inbound) or last_inbound>evaluated_at then 'invalid_inbound'
    when evaluated_at>=last_inbound+interval '24 hours' then 'expired' else 'open' end as reason) decision
$$;
revoke all on function koi_private.inbox_reply_window(timestamptz,timestamptz,text) from public,anon,authenticated;

commit;
