-- Return only the shortcode for a shared reel. Signed media URLs and tracking parameters stay private.
create or replace function koi_private.inbox_message_view_pre_interactions(m koi_private.inbox_messages,preview boolean default false) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',m.id,'seq',m.seq,'externalId',m.external_id,'clientKey',(select request_id from koi_private.inbox_outbox where message_id=m.id),'sendReason',(select reason from koi_private.inbox_outbox where message_id=m.id),'direction',m.direction,'body',case when preview then left(m.body,300) else m.body end,
 'sent_at',m.sent_at,'status',m.status,'delivery',m.delivery,'historical',m.historical,
 'attachment_mime',coalesce(m.provider_attachments->0->>'mimeType',case m.provider_attachments->0->>'type' when 'image' then 'image/jpeg' when 'video' then 'video/mp4' when 'audio' then 'audio/mpeg' when 'sticker' then 'image/webp' else case when jsonb_array_length(m.provider_attachments)>0 then 'application/octet-stream' end end),
 'attachment_name',coalesce(m.provider_attachments->0->>'filename','Adjunto'),
 'attachments',coalesce((select jsonb_agg(jsonb_build_object('index',pos-1,'type',value->>'type','originalType',value->>'originalType','mimeType',value->>'mimeType','filename',value->>'filename') ||
    case when not preview and value->>'originalType' in ('ig_reel','reel') then
      jsonb_strip_nulls(jsonb_build_object('instagramReelCode',
        substring(value->>'sourceUrl' from '^https://(?:www\.)?instagram\.com/reel/([A-Za-z0-9_-]{1,64})/?(?:[?#].*)?$')))
    else '{}'::jsonb end order by pos)
  from jsonb_array_elements(m.provider_attachments) with ordinality a(value,pos)),'[]'))
$$;
