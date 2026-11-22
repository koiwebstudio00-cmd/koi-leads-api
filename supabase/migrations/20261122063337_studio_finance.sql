begin;
create table koi_private.finance_owners (
 workspace_id uuid, user_id uuid, source text not null, source_owner_id uuid not null,
 primary key(workspace_id,user_id), unique(workspace_id,source,source_owner_id),
 foreign key(workspace_id,user_id) references public.koi_workspace_members on delete cascade
);
create table koi_private.finance_budgets (
 workspace_id uuid,project_id uuid,amount numeric(18,2) not null check(amount>=0),currency text not null check(currency in ('ARS','USD','USDT')),
 revision int not null default 0,source text,source_id uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(workspace_id,project_id),unique(workspace_id,source,source_id),foreign key(workspace_id,project_id) references koi_private.studio_projects
);
create table koi_private.finance_movements (
 workspace_id uuid references public.koi_workspaces,id uuid default gen_random_uuid(), type text not null check(type in ('income','expense')),
 status text not null check(status in ('pending','settled','cancelled')),concept text not null check(length(trim(concept)) between 1 and 160),
 category text not null check(length(trim(category)) between 1 and 80),amount numeric(20,8) not null check(amount>0),
 currency text not null check(currency in ('ARS','USD','USDT')),payment_method text check(payment_method in ('transfer','crypto','cash','card','other')),
 occurred_on date not null,due_date date,settled_on date,notes text,project_id uuid,client_id uuid,
 recurrence text not null check(recurrence in ('none','monthly')),series_id uuid,author uuid not null,revision int not null default 0,
 source text,source_id uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(workspace_id,id),unique(workspace_id,source,source_id),
 foreign key(workspace_id,project_id) references koi_private.studio_projects,
 foreign key(workspace_id,client_id) references koi_private.clients,
 foreign key(workspace_id,client_id,project_id) references koi_private.client_projects,
 check((status='settled')=(settled_on is not null))
);
create unique index finance_series_month on koi_private.finance_movements(workspace_id,series_id,(date_trunc('month',coalesce(due_date,occurred_on)::timestamp))) where series_id is not null;
create index finance_settled on koi_private.finance_movements(workspace_id,settled_on) where status='settled';
alter table koi_private.finance_owners enable row level security;
alter table koi_private.finance_movements enable row level security;
alter table koi_private.finance_budgets enable row level security;
revoke all on koi_private.finance_owners,koi_private.finance_movements,koi_private.finance_budgets from public,anon,authenticated;

create function koi_private.finance_next(m koi_private.finance_movements) returns void language plpgsql security invoker set search_path='' as $$
declare next_date date:=(coalesce(m.due_date,m.occurred_on)+interval '1 month')::date;
begin
 if m.recurrence='monthly' and m.series_id is not null and m.status<>'cancelled' then
  insert into koi_private.finance_movements(workspace_id,type,status,concept,category,amount,currency,payment_method,occurred_on,due_date,notes,project_id,client_id,recurrence,series_id,author)
  values(m.workspace_id,m.type,'pending',m.concept,m.category,m.amount,m.currency,m.payment_method,next_date,next_date,m.notes,m.project_id,m.client_id,'monthly',m.series_id,m.author)
  on conflict(workspace_id,series_id,(date_trunc('month',coalesce(due_date,occurred_on)::timestamp))) where series_id is not null do nothing;
 end if;
end $$;
revoke all on function koi_private.finance_next(koi_private.finance_movements) from public,anon,authenticated;

create function koi_private.finance_command(action text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a uuid:=auth.uid();w uuid;allowed boolean;pid uuid:=(p->>'projectId')::uuid;cid uuid:=(p->>'clientId')::uuid;
 mid uuid:=(p->>'id')::uuid;req uuid:=(p->>'key')::uuid;m koi_private.finance_movements;prior koi_private.project_events;
 result jsonb;signature jsonb; from_day date;to_day date;today date:=(now() at time zone 'America/Argentina/Tucuman')::date;
begin
 select workspace_id into w from public.koi_workspace_members where user_id=a;
 select exists(select 1 from koi_private.finance_owners where workspace_id=w and user_id=a) into allowed;
 if action='access' then return to_jsonb(allowed); end if;
 if not allowed then raise exception 'Finance access required' using errcode='42501'; end if;
 if action='summary' then
  from_day:=coalesce((p->>'from')::date,today-29);to_day:=coalesce((p->>'to')::date,today);
  if from_day>to_day then raise exception 'Invalid period' using errcode='22023';end if;
  return jsonb_build_object('from',from_day,'to',to_day,'totals',(select coalesce(jsonb_agg(to_jsonb(t) order by t.currency),'[]') from (
   select currency,coalesce(sum(amount) filter(where type='income'),0)::text income,coalesce(sum(amount) filter(where type='expense'),0)::text expense,
   sum(case when type='income' then amount else -amount end)::text net from koi_private.finance_movements
   where workspace_id=w and status='settled' and settled_on between from_day and to_day group by currency) t));
 elsif action='list' then
  return jsonb_build_object('movements',(select coalesce(jsonb_agg(to_jsonb(f)||jsonb_build_object('amount',f.amount::text) order by f.occurred_on desc,f.created_at desc,f.id),'[]')
   from koi_private.finance_movements f where f.workspace_id=w and (pid is null or f.project_id=pid) and (cid is null or f.client_id=cid)),
   'budgets',(select coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('amount',b.amount::text) order by b.project_id),'[]')
   from koi_private.finance_budgets b where b.workspace_id=w and (pid is null or b.project_id=pid) and
   (cid is null or exists(select 1 from koi_private.studio_projects s join koi_private.client_projects cp on cp.workspace_id=s.workspace_id and cp.project_id=s.id
    where s.workspace_id=w and s.id=b.project_id and s.ownership='client' and cp.client_id=cid))));
 elsif action='due' then
  return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'title',concept,'due_date',due_date,'amount',amount::text,'currency',currency,'type',type) order by due_date,id),'[]')
  from koi_private.finance_movements where workspace_id=w and status='pending' and due_date is not null);
 end if;
 if req is null then raise exception 'Missing key' using errcode='22023';end if;
 signature:=to_jsonb(encode(sha256(convert_to(p::text,'UTF8')),'hex'));
 perform pg_advisory_xact_lock(hashtextextended(w::text||a::text||req::text,0));
 select * into prior from koi_private.project_events where workspace_id=w and actor=a and request_id=req;
 if found then
  if prior.action='finance:'||action and prior.payload=signature then return prior.result;end if;
  raise exception 'Request conflict' using errcode='PT409';
 end if;
 case action
 when 'create' then
  mid:=gen_random_uuid();
  insert into koi_private.finance_movements(workspace_id,id,type,status,concept,category,amount,currency,payment_method,occurred_on,due_date,settled_on,notes,project_id,client_id,recurrence,series_id,author)
  values(w,mid,p->>'type',p->>'status',p->>'concept',p->>'category',(p->>'amount')::numeric,p->>'currency',p->>'payment_method',(p->>'occurred_on')::date,(p->>'due_date')::date,
   (p->>'settled_on')::date,p->>'notes',pid,cid,p->>'recurrence',case when p->>'recurrence'='monthly' then mid end,a) returning * into m;
  perform koi_private.finance_next(m);
 when 'edit' then
  update koi_private.finance_movements set type=p->>'type',concept=p->>'concept',category=p->>'category',amount=(p->>'amount')::numeric,currency=p->>'currency',
    payment_method=p->>'payment_method',occurred_on=(p->>'occurred_on')::date,due_date=(p->>'due_date')::date,settled_on=(p->>'settled_on')::date,
    notes=p->>'notes',project_id=pid,client_id=cid,revision=revision+1,updated_at=now()
   where workspace_id=w and id=mid and revision=(p->>'revision')::int and status=p->>'status' and recurrence=p->>'recurrence';
  if not found then raise exception 'Movement changed' using errcode='PT409';end if;
 when 'resolve' then
  if p->>'status' not in ('settled','cancelled') then raise exception 'Invalid settlement' using errcode='22023';end if;
  update koi_private.finance_movements set status=p->>'status',settled_on=(p->>'settled_on')::date,payment_method=coalesce(p->>'payment_method',payment_method),revision=revision+1,updated_at=now()
  where workspace_id=w and id=mid and status='pending' and revision=(p->>'revision')::int returning * into m;
  if not found then raise exception 'Movement changed' using errcode='PT409';end if;
  perform koi_private.finance_next(m);
 when 'budget' then
  if (p->>'revision')::int=-1 then
   insert into koi_private.finance_budgets(workspace_id,project_id,amount,currency) values(w,pid,(p->>'amount')::numeric,p->>'currency') on conflict do nothing;
  else
   update koi_private.finance_budgets set amount=(p->>'amount')::numeric,currency=p->>'currency',revision=revision+1,updated_at=now()
   where workspace_id=w and project_id=pid and revision=(p->>'revision')::int;
  end if;
  if not found then raise exception 'Budget changed' using errcode='PT409';end if;
  mid:=pid;
 else raise exception 'Unknown finance action' using errcode='22023';
 end case;
 result:=jsonb_build_object('id',mid);
 insert into koi_private.project_events(workspace_id,actor,request_id,action,payload,result) values(w,a,req,'finance:'||action,signature,result);
 return result;
end $$;
create function public.koi_finance_command(action text,p jsonb) returns jsonb language sql security invoker set search_path='' as $$select koi_private.finance_command(action,p)$$;
revoke all on function koi_private.finance_command(text,jsonb),public.koi_finance_command(text,jsonb) from public,anon;
grant execute on function koi_private.finance_command(text,jsonb),public.koi_finance_command(text,jsonb) to authenticated;
commit;
