begin;
-- The provider can expire signed media. Capture recent inbound files independently
-- of delivery acknowledgement; keep a bounded rolling cache per workspace.
create table koi_private.inbox_received_cache (
 message_id uuid not null references koi_private.inbox_messages(id) on delete cascade,
 position integer not null check(position between 0 and 99),
 workspace_id uuid not null references public.koi_workspaces(id),
 created_at timestamptz not null default now(), retry_at timestamptz not null default now(),
 attempts integer not null default 0, lease uuid, bytes bytea, mime text,
 primary key(message_id,position),
 check (octet_length(bytes)<=8388608)
);
alter table koi_private.inbox_received_cache enable row level security;
revoke all on koi_private.inbox_received_cache from public,anon,authenticated;
create index inbox_received_queue on koi_private.inbox_received_cache(workspace_id,retry_at) where bytes is null and attempts<3;
create index inbox_received_expiry on koi_private.inbox_received_cache(workspace_id,created_at);

create function koi_private.inbox_schedule_received() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.direction='in' and not new.historical and new.sent_at>now()-interval '1 day' then
   delete from koi_private.inbox_received_cache where workspace_id=new.workspace_id and created_at<now()-interval '7 days';
   insert into koi_private.inbox_received_cache(message_id,workspace_id,position)
   select new.id,new.workspace_id,n from generate_series(0,least(99,jsonb_array_length(new.provider_attachments)-1)) n
   on conflict do nothing;
 end if;
 return new;
end $$;
revoke all on function koi_private.inbox_schedule_received() from public,anon,authenticated;
create trigger inbox_received_schedule after insert or update of provider_attachments on koi_private.inbox_messages
for each row execute function koi_private.inbox_schedule_received();

create function public.koi_inbox_received_media(data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare locator jsonb; item jsonb; cached jsonb; ch text;
begin
 -- Reuse the existing membership, lead visibility, conversation and attachment checks.
 locator:=public.koi_inbox_query('media_lookup',data);
 select m.provider_attachments->((data->>'index')::int),c.channel into strict item,ch
 from koi_private.inbox_messages m join public.koi_inbox_conversations c on c.id=m.conversation_id
 where m.id=(data->>'messageId')::uuid and c.id=(data->>'id')::uuid;
 select jsonb_build_object('name',locator->>'name','mime',v.mime,'base64',replace(encode(v.bytes,'base64'),chr(10),'')) into cached
 from koi_private.inbox_received_cache v where v.message_id=(data->>'messageId')::uuid and v.position=(data->>'index')::int
 and v.bytes is not null and v.created_at>now()-interval '7 days';
 return locator || jsonb_strip_nulls(jsonb_build_object('channel',ch,'mediaId',item->>'mediaId','mime',item->>'mimeType','cached',cached));
end $$;
revoke all on function public.koi_inbox_received_media(jsonb) from public,anon,authenticated;
grant execute on function public.koi_inbox_received_media(jsonb) to authenticated;

create function koi_private.inbox_receive_job(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b koi_private.inbox_bindings; j koi_private.inbox_received_cache; lookup jsonb; raw bytea;
begin
 select * into b from koi_private.inbox_bindings where role_name=session_user and kind='ingest';
 if b.workspace_id is null or not pg_has_role(session_user,'koi_inbox_ingest','member') or not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin')
 then raise exception 'Worker required' using errcode='42501'; end if;
 if action='claim' then
   delete from koi_private.inbox_received_cache where workspace_id=b.workspace_id and created_at<now()-interval '7 days';
   select * into j from koi_private.inbox_received_cache where workspace_id=b.workspace_id and bytes is null and retry_at<=now() and attempts<3
     order by retry_at for update skip locked limit 1;
   if j.message_id is null then return null; end if;
   update koi_private.inbox_received_cache set lease=gen_random_uuid(),attempts=attempts+1,retry_at=now()+interval '3 minutes'
   where message_id=j.message_id and position=j.position returning * into j;
   select jsonb_strip_nulls(jsonb_build_object('accountId',a.external_id,'channel',a.channel,'conversationId',c.external_id,
     'messageId',m.external_id,'index',j.position,'mediaId',item->>'mediaId','sourceUrl',item->>'sourceUrl','originalType',item->>'originalType',
     'mime',item->>'mimeType','name',coalesce(item->>'filename','Adjunto'))) into lookup
   from koi_private.inbox_messages m join public.koi_inbox_conversations c on c.id=m.conversation_id join public.koi_inbox_accounts a on a.id=m.account_id
   cross join lateral (select m.provider_attachments->j.position as item) content where m.id=j.message_id and m.workspace_id=b.workspace_id;
   return jsonb_build_object('id',j.message_id,'index',j.position,'lease',j.lease,'lookup',lookup);
 elsif action='save' then
   if length(p->>'base64')>11184812 then raise exception 'Media exceeds cache limit' using errcode='22023';end if;
   raw:=decode(p->>'base64','base64');
   update koi_private.inbox_received_cache set bytes=raw,mime=left(p->>'mime',100),lease=null
   where workspace_id=b.workspace_id and message_id=(p->>'id')::uuid and position=(p->>'index')::int and lease=(p->>'lease')::uuid;
   -- Evict the oldest bytes first. Trimming takes place only after a successful write.
   delete from koi_private.inbox_received_cache where workspace_id=b.workspace_id and (message_id,position) in
    (select message_id,position from (select message_id,position,sum(octet_length(bytes)) over(order by created_at desc,message_id,position) as total
     from koi_private.inbox_received_cache where workspace_id=b.workspace_id and bytes is not null) sizes where total>134217728);
 elsif action='fail' then
   update koi_private.inbox_received_cache set lease=null,retry_at=now()+interval '2 minutes',attempts=case when p->>'permanent'='true' then 3 else attempts end
   where workspace_id=b.workspace_id and message_id=(p->>'id')::uuid and position=(p->>'index')::int and lease=(p->>'lease')::uuid;
 else raise exception 'Invalid action' using errcode='22023';
 end if;
 return null;
end $$;
revoke all on function koi_private.inbox_receive_job(text,jsonb) from public,anon,authenticated;
grant execute on function koi_private.inbox_receive_job(text,jsonb) to koi_inbox_ingest;
commit;
