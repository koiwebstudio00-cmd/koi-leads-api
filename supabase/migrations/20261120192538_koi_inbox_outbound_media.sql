begin;
-- Attached bytes are scoped and retained with the queued message, never put on Realtime.
create table koi_private.inbox_sent_files (
  job_id uuid primary key references koi_private.inbox_outbox(id) on delete cascade,
  file_name text not null check(char_length(file_name) between 1 and 120),
  mime text not null,
  content bytea not null check(octet_length(content) between 1 and 8388608),
  voice_note boolean not null default false
);
alter table koi_private.inbox_sent_files enable row level security;
revoke all on koi_private.inbox_sent_files from public,anon,authenticated;
alter table koi_private.inbox_messages add column native_sticker text check(native_sticker='like_heart');
create or replace function koi_private.inbox_message_view(m koi_private.inbox_messages,preview boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$
 select koi_private.inbox_message_view_pre_interactions(m,preview)
   || case when preview then '{}'::jsonb else koi_private.inbox_message_interactions(m) end
   || case when m.native_sticker is null then '{}'::jsonb else jsonb_build_object('nativeSticker',m.native_sticker) end
$$;
create function koi_private.inbox_file_json(f koi_private.inbox_sent_files) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('name',f.file_name,'mime',f.mime,'base64',replace(encode(f.content,'base64'),chr(10),''),'voiceNote',f.voice_note)
$$;
revoke all on function koi_private.inbox_file_json(koi_private.inbox_sent_files) from public,anon,authenticated;

-- Authenticated users can call the RPC directly; validate the channel, container and limits in SQL.
create function koi_private.inbox_file_type(ch text, mime text, raw bytea, voice boolean) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare size integer:=octet_length(raw); head integer; office_part text;
begin
 if raw is null or size not between 1 and 8388608 or mime is null then return null; end if;
 if voice and (ch<>'whatsapp' or mime not in ('audio/ogg','audio/webm','audio/mp4') or size>4194304) then return null; end if;
 if ch='whatsapp' and mime='text/plain' then
   begin
     perform convert_from(raw,'UTF8');
     return 'file';
   exception when character_not_in_repertoire or untranslatable_character then return null;
   end;
 end if;
 if size<4 then return null; end if;
 if ch='whatsapp' and substring(raw from 1 for 4)=decode('504b0304','hex') and size>=22 then
   office_part:=case mime when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'word/document.xml'
     when 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then 'xl/workbook.xml'
     when 'application/vnd.openxmlformats-officedocument.presentationml.presentation' then 'ppt/presentation.xml' end;
   if office_part is not null and position(decode('504b0506','hex') in raw)>0
     and position(convert_to('[Content_Types].xml','UTF8') in raw)>0
     and position(convert_to(office_part,'UTF8') in raw)>0
     and position(convert_to('vbaProject.bin','UTF8') in raw)=0 then return 'file'; end if;
 end if;
 if mime in ('image/jpeg','image/png') and size <= (case when ch='whatsapp' then 5000000 else 8000000 end)
    and ((mime='image/jpeg' and substring(raw from 1 for 3)=decode('ffd8ff','hex')) or
         (mime='image/png' and substring(raw from 1 for 8)=decode('89504e470d0a1a0a','hex'))) then return 'image'; end if;
 if mime='application/pdf' and substring(raw from 1 for 5)=convert_to('%PDF-','UTF8') then return 'file'; end if;
 if mime in ('audio/mp4','video/mp4') and size>=12 and substring(raw from 5 for 4)=convert_to('ftyp','UTF8')
   then return split_part(mime,'/',1); end if;
 if ch='whatsapp' and mime='audio/ogg' and size>=38 and substring(raw from 1 for 4)=convert_to('OggS','UTF8') and get_byte(raw,4)=0 then
   head:=27+get_byte(raw,26);
   if size>=head+10 and substring(raw from head+1 for 8)=convert_to('OpusHead','UTF8') and (not voice or get_byte(raw,head+9)=1) then return 'audio'; end if;
 end if;
 if ch='whatsapp' and mime='audio/mpeg' and (substring(raw from 1 for 3)=convert_to('ID3','UTF8') or
    (get_byte(raw,0)=255 and (get_byte(raw,1) & 224)=224)) then return 'audio'; end if;
 if ch='instagram' and mime='audio/wav' and substring(raw from 1 for 4)=convert_to('RIFF','UTF8') and
   substring(raw from 9 for 4)=convert_to('WAVE','UTF8') then return 'audio'; end if;
 if ((ch='instagram' and mime='video/webm') or (ch='whatsapp' and voice and mime='audio/webm'))
   and substring(raw from 1 for 4)=decode('1a45dfa3','hex') and position(convert_to('webm','UTF8') in substring(raw from 5 for 124))>0
   then return split_part(mime,'/',1); end if;
 return null;
end $$;
revoke all on function koi_private.inbox_file_type(text,text,bytea,boolean) from public,anon,authenticated;
create or replace function public.koi_inbox_send(action text,data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); w uuid; members integer; c public.koi_inbox_conversations;
 a public.koi_inbox_accounts; o koi_private.inbox_outbox; m koi_private.inbox_messages; body text; key uuid; fingerprint text;
 file_data jsonb; raw bytea; file_kind text; voice boolean; sticker text; quoted text; file_name text; mime text;
begin
 select count(*),min(workspace_id::text)::uuid into members,w from public.koi_workspace_members where user_id=actor and role in ('admin','operator');
 if actor is null or members<>1 then raise exception 'Membership required' using errcode='42501'; end if;
 if action is null or action not in ('send','resolve_send','local_media') then raise exception 'Invalid action' using errcode='22023'; end if;
 select x.* into c from public.koi_inbox_conversations x join public.koi_leads l on l.id=x.lead_id
 where x.id=(data->>'id')::uuid and x.workspace_id=w and l.deleted_at is null for update of x;
 if c.id is null then raise exception 'Conversation not found' using errcode='PT404'; end if;
 if action='local_media' then
   if (data->>'index')::integer is distinct from 0 then return null; end if;
   return (select koi_private.inbox_file_json(f) from koi_private.inbox_outbox j join koi_private.inbox_sent_files f on f.job_id=j.id
     where j.workspace_id=w and j.conversation_id=c.id and j.message_id=(data->>'messageId')::uuid);
 end if;
 if action='resolve_send' then
   select * into o from koi_private.inbox_outbox where workspace_id=w and conversation_id=c.id and message_id=(data->>'messageId')::uuid for update;
   if o.id is null then raise exception 'Message not found' using errcode='PT404'; end if;
   if o.status<>'unknown' then raise exception 'Message changed' using errcode='PT409'; end if;
   update koi_private.inbox_outbox set status='closed',reason='reviewed',lease_token=null,lease_until=null where id=o.id;
   update koi_private.inbox_messages set status='closed' where id=o.message_id returning * into m;
 else
   body:=coalesce(btrim(data->>'text'),''); key:=(data->>'requestId')::uuid;
   file_data:=data->'attachment'; sticker:=data->>'sticker';
   if key is null or char_length(body)>10000 or
      (data?'text' and jsonb_typeof(data->'text')<>'string') or (data-'id'-'text'-'requestId'-'attachment'-'sticker'-'quoteTo')<>'{}'
     then raise exception 'Invalid message' using errcode='22023'; end if;
   if sticker is not null and (sticker<>'like_heart' or c.channel<>'instagram' or body<>'' or file_data is not null or data?'quoteTo')
     then raise exception 'Invalid sticker' using errcode='22023'; end if;
   if body='' and file_data is null and sticker is null then raise exception 'Empty message' using errcode='22023'; end if;
   if file_data is not null then
     if jsonb_typeof(file_data)<>'object' or (file_data-'mime'-'name'-'base64'-'voiceNote')<>'{}'
       or jsonb_typeof(file_data->'base64') is distinct from 'string'
       or jsonb_typeof(file_data->'mime') is distinct from 'string' or jsonb_typeof(file_data->'name') is distinct from 'string'
       or (file_data?'voiceNote' and jsonb_typeof(file_data->'voiceNote')<>'boolean')
       or length(file_data->>'base64') not between 4 and 11184812 then raise exception 'Invalid attachment' using errcode='22023'; end if;
     file_name:=btrim(file_data->>'name'); mime:=file_data->>'mime'; voice:=coalesce((file_data->>'voiceNote')::boolean,false);
     if char_length(file_name) not between 1 and 120 or file_name ~ '[[:cntrl:]/]' or position(chr(92) in file_name)>0
       then raise exception 'Invalid filename' using errcode='22023'; end if;
     raw:=decode(file_data->>'base64','base64');
     file_kind:=koi_private.inbox_file_type(c.channel,mime,raw,voice);
     if file_kind is null or replace(encode(raw,'base64'),chr(10),'')<>(file_data->>'base64') or
       (body<>'' and (c.channel='instagram' or file_kind='audio')) then raise exception 'Unsupported attachment or caption' using errcode='22023'; end if;
   end if;
   if file_data is null and sticker is null and not (data?'quoteTo') then
     -- Preserve the hash of historical text retries.
     fingerprint:=encode(sha256(convert_to(jsonb_build_array(c.id,body)::text,'UTF8')),'hex');
   else
     fingerprint:=encode(sha256(convert_to(jsonb_build_array(c.id,body,file_name,mime,voice,encode(sha256(raw),'hex'),sticker,data->>'quoteTo')::text,'UTF8')),'hex');
   end if;
   -- A request key is durable, scoped to its author, and cannot be repurposed.
   perform pg_advisory_xact_lock(hashtextextended(actor::text||key::text,918));
   select * into o from koi_private.inbox_outbox where workspace_id=w and actor_id=actor and request_id=key;
   if o.id is not null then
     if o.request_hash<>fingerprint then raise exception 'Idempotency conflict' using errcode='PT409'; end if;
     select * into m from koi_private.inbox_messages where id=o.message_id;
     return koi_private.inbox_message_view(m);
   end if;
   if data?'quoteTo' then
     if (data->>'quoteTo') is null then raise exception 'Missing quoted message' using errcode='22023'; end if;
     quoted:=koi_private.inbox_quote_external(c,(data->>'quoteTo')::uuid);
   end if;
   select * into a from public.koi_inbox_accounts where id=c.account_id;
   if not (koi_private.inbox_effective_window(c,a,clock_timestamp(),file_data is null and sticker is null)->>'canReply')::boolean then raise exception 'Reply window closed' using errcode='PT422'; end if;
   if exists(select 1 from koi_private.inbox_outbox where conversation_id=c.id and status='unknown') then raise exception 'Review uncertain send' using errcode='PT423'; end if;
   insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,direction,body,sent_at,actor_id,status,quoted_external_id,native_sticker,provider_attachments)
   values(w,c.account_id,c.id,'out',case when sticker is null then body else '❤️' end,clock_timestamp(),actor,'queued',quoted,sticker,
   case when file_data is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('type',file_kind,'mimeType',mime,'filename',file_name)) end) returning * into m;
   insert into koi_private.inbox_outbox(workspace_id,account_id,conversation_id,message_id,actor_id,request_id,request_hash)
   values(w,c.account_id,c.id,m.id,actor,key,fingerprint) returning * into o;
   if file_data is not null then
     insert into koi_private.inbox_sent_files(job_id,file_name,mime,content,voice_note) values(o.id,file_name,mime,raw,voice);
   end if;
 end if;
 update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
 return koi_private.inbox_message_view(m);
end $$;
revoke all on function public.koi_inbox_send(text,jsonb) from public,anon,authenticated;
grant execute on function public.koi_inbox_send(text,jsonb) to authenticated;

-- The existing Inbox worker has a second bounded loop, with the same scoped login.
create or replace function koi_private.inbox_dispatch(action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b koi_private.inbox_bindings; o koi_private.inbox_outbox; c public.koi_inbox_conversations;
 a public.koi_inbox_accounts; m koi_private.inbox_messages; duplicate koi_private.inbox_messages;
 expiry jsonb; outcome text; why text; result jsonb; ext text;
begin
 select * into b from koi_private.inbox_bindings where role_name=session_user and kind='ingest';
 if b.role_name is null or not pg_has_role(session_user,'koi_inbox_ingest','member') or not exists(
 select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=b.actor_id and role='admin') then raise exception 'Unbound worker' using errcode='42501'; end if;
 if action is null or action not in ('claim','begin','finish','defer','prepare_media') then raise exception 'Invalid dispatch action' using errcode='22023'; end if;
 -- Short transaction lock only. Provider calls happen outside transactions and may run concurrently.
 perform pg_advisory_xact_lock(hashtextextended(b.workspace_id::text,919));
 if action='claim' then
   for o in select * from koi_private.inbox_outbox where workspace_id=b.workspace_id and status in ('leased','sending') and lease_until<clock_timestamp() for update loop
     outcome:=case when o.status='sending' then 'unknown' else 'queued' end;
     update koi_private.inbox_outbox set status=outcome,reason=case when outcome='unknown' then 'interrupted_send' end,lease_token=null,lease_until=null where id=o.id;
     update koi_private.inbox_messages set status=outcome where id=o.message_id;
     update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=o.conversation_id;
   end loop;
   select x.* into o from koi_private.inbox_outbox x where x.workspace_id=b.workspace_id and x.status='queued' and x.retry_at<=clock_timestamp()
   and not exists(select 1 from koi_private.inbox_outbox prior where prior.conversation_id=x.conversation_id and prior.status in ('queued','leased','sending','unknown') and (prior.created_at,prior.id)<(x.created_at,x.id))
   and not exists(select 1 from koi_private.inbox_outbox active where active.conversation_id=x.conversation_id and active.status in ('leased','sending','unknown'))
   order by x.created_at,x.id for update skip locked limit 1;
   if o.id is null then return null; end if;
   update koi_private.inbox_outbox set status='leased',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' where id=o.id returning * into o;
   select * into c from public.koi_inbox_conversations where id=o.conversation_id;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   return jsonb_build_object('hasAttachment',exists(select 1 from koi_private.inbox_sent_files where job_id=o.id),
     'richContent',exists(select 1 from koi_private.inbox_messages where id=o.message_id and (native_sticker is not null or quoted_external_id is not null)),
     'id',o.id,'lease',o.lease_token,'accountId',a.external_id,'conversationId',c.external_id,
     'channel',c.channel,'profileId',b.profile_id,'workspaceId',b.workspace_id);
 end if;
 -- Same lock order as ingestion: conversation before message/outbox mutation.
 select x.* into c from public.koi_inbox_conversations x join koi_private.inbox_outbox job on job.conversation_id=x.id where job.id=(p->>'id')::uuid and job.workspace_id=b.workspace_id for update of x;
 select * into o from koi_private.inbox_outbox where id=(p->>'id')::uuid and workspace_id=b.workspace_id for update;
 if o.id is null or o.lease_token is distinct from (p->>'lease')::uuid or o.lease_token is null or o.lease_until<clock_timestamp() then return null; end if;
 if action='prepare_media' then
   if o.status<>'leased' then return null; end if;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   if not (koi_private.inbox_effective_window(c,a,clock_timestamp(),false)->>'canReply')::boolean
     or not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=o.actor_id and role in ('admin','operator'))
     or exists(select 1 from public.koi_leads where id=c.lead_id and deleted_at is not null) then
     -- Let begin retire the invalid work without processing a file.
     perform koi_private.inbox_dispatch('begin',p);
     return null;
   end if;
   -- Conversion and upload run while leased. Only begin can move this job to sending.
   update koi_private.inbox_outbox set lease_until=clock_timestamp()+interval '60 seconds' where id=o.id;
   return (select koi_private.inbox_file_json(f) from koi_private.inbox_sent_files f where f.job_id=o.id);
 end if;
 if action='begin' then
   if o.status<>'leased' then return null; end if;
   select * into a from public.koi_inbox_accounts where id=o.account_id;
   select * into m from koi_private.inbox_messages where id=o.message_id;
   expiry:=koi_private.inbox_effective_window(c,a,clock_timestamp(),m.native_sticker is null and not exists(select 1 from koi_private.inbox_sent_files where job_id=o.id));
   why:=case when not (expiry->>'canReply')::boolean then expiry->>'reason'
     when not exists(select 1 from public.koi_workspace_members where workspace_id=b.workspace_id and user_id=o.actor_id and role in ('admin','operator')) then 'member_removed'
     when exists(select 1 from public.koi_leads where id=c.lead_id and deleted_at is not null) then 'contact_deleted' end;
   if why is not null then
     update koi_private.inbox_outbox set status='failed',reason=why,lease_token=null,lease_until=null where id=o.id;
     update koi_private.inbox_messages set status='failed' where id=o.message_id;
     update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;return null;
   end if;
   update koi_private.inbox_outbox set status='sending',attempts=attempts+1,dispatched_at=clock_timestamp(),lease_until=clock_timestamp()+interval '45 seconds' where id=o.id;
   update koi_private.inbox_messages set status='sending' where id=o.message_id returning * into m;
   update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
   return jsonb_build_object('text',m.body,'requestId',o.id,'expiresAt',expiry->>'expiresAt','replyTo',m.quoted_external_id,'humanAgent',expiry->>'mode'='human_agent','sticker',m.native_sticker);
 elsif action='defer' then
   if o.status<>'leased' then return null; end if;
   outcome:=case when p->>'terminal'='true' then 'failed' else 'queued' end;
 elsif action='finish' then
   if o.status<>'sending' then return null; end if;
   outcome:=p->>'outcome';
   if outcome not in ('accepted','failed','unknown','queued') or outcome is null then raise exception 'Invalid outcome' using errcode='22023'; end if;
   if outcome='queued' and o.attempts>=5 then outcome:='failed'; end if;
   if outcome='accepted' then
     ext:=p->>'externalId';
     if ext is null or char_length(ext) not between 1 and 200 then raise exception 'Missing message identity' using errcode='22023'; end if;
     select * into duplicate from koi_private.inbox_messages where workspace_id=b.workspace_id and account_id=o.account_id and external_id=ext;
     if duplicate.id is not null and duplicate.id<>o.message_id then
       if duplicate.conversation_id<>c.id or duplicate.direction<>'out' or exists(select 1 from koi_private.inbox_outbox where message_id=duplicate.id) then raise exception 'Message identity conflict' using errcode='22023'; end if;
       -- A webhook/history page can arrive before the POST response. Preserve the local id.
       update koi_private.inbox_reads set through_message_id=o.message_id where through_message_id=duplicate.id;
       delete from koi_private.inbox_messages where id=duplicate.id;
     end if;
     update koi_private.inbox_messages set external_id=ext,status='accepted',sent_at=coalesce(duplicate.sent_at,o.dispatched_at),
       quoted_external_id=coalesce(quoted_external_id,duplicate.quoted_external_id),delivery=coalesce(duplicate.delivery,'sent'),historical=false where id=o.message_id;
     update public.koi_inbox_conversations set last_outbound_at=case when duplicate.delivery='error' then last_outbound_at else greatest(last_outbound_at,coalesce(duplicate.sent_at,o.dispatched_at)) end where id=c.id;
   end if;
 end if;
 update koi_private.inbox_outbox set status=outcome,reason=case when outcome='accepted' then null else left(p->>'reason',100) end,
 lease_token=null,lease_until=null,retry_at=clock_timestamp()+make_interval(secs=>least(3600,greatest(5,coalesce((p->>'retryAfter')::int,30)))) where id=o.id;
 if outcome<>'accepted' then update koi_private.inbox_messages set status=outcome where id=o.message_id; end if;
 if outcome='unknown' then
   -- Refresh provider evidence, but never match sends by text or assume an empty history proves failure.
   insert into koi_private.inbox_sync_jobs(workspace_id,account_id) values(b.workspace_id,o.account_id)
   on conflict(account_id,conversation_key) do update set retry_at=least(koi_private.inbox_sync_jobs.retry_at,clock_timestamp());
 end if;
 update public.koi_inbox_conversations set updated_at=clock_timestamp() where id=c.id;
 return jsonb_build_object('status',outcome);
end $$;
revoke all on function koi_private.inbox_dispatch(text,jsonb) from public,anon,authenticated,koi_inbox_gateway;
grant execute on function koi_private.inbox_dispatch(text,jsonb) to koi_inbox_ingest;
commit;
