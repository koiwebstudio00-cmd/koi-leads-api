import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { InboxOutboundFile } from './outbound-media.ts'

const presignResult = z.object({ uploadUrl: z.url(), publicUrl: z.url() })
const fileExtensions: Record<InboxOutboundFile['mime'], string> = {
  'image/jpeg':'jpg','image/png':'png','audio/mpeg':'mp3','audio/mp4':'m4a',
  'audio/ogg':'ogg','audio/wav':'wav','audio/webm':'webm','video/mp4':'mp4','video/webm':'webm',
  'application/pdf':'pdf','text/plain':'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
}
function trustedUrl(raw: string, kind: 'upload' | 'public'): URL {
  const url = new URL(raw)
  const hostAllowed = kind === 'upload'
    ? /^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname)
    : url.hostname === 'media.zernio.com'
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hostAllowed)
    throw new Error('Invalid provider media endpoint')
  return url
}

// The private binary reaches Zernio only when the operator dispatches this message.
// Zernio's presigned flow accepts files larger than its hosted multipart body limit.
export async function uploadInboxAttachment(file: InboxOutboundFile, apiKey: string, fetcher: typeof fetch) {
  const bytes = Buffer.from(file.base64, 'base64')
  const presign = await fetcher('https://zernio.com/api/v1/media/presign', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    // The provider's temporary URL should not expose a user's original filename.
    // The message's attachmentName separately preserves the name for the recipient.
    body: JSON.stringify({ filename: randomUUID()+'.'+fileExtensions[file.mime], contentType: file.mime, size: bytes.length }),
  })
  if (!presign.ok) throw new Error('Provider could not prepare upload')
  const urls = presignResult.parse(await presign.json())
  const uploadUrl = trustedUrl(urls.uploadUrl, 'upload')
  const publicUrl = trustedUrl(urls.publicUrl, 'public')
  const put = await fetcher(uploadUrl, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': file.mime }, body: bytes,
  })
  if (!put.ok) throw new Error('Provider upload failed')
  return publicUrl.toString()
}
