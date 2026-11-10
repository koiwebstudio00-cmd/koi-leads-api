import { z } from 'zod'
import type { IncomingMessage } from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from './store.ts'
import type { SendOutcome } from './campaigns/contracts.ts'

export type ChatCommand = (action: string, data: Record<string, unknown>) => Promise<unknown>
export const maxAttachmentBytes = 4 * 1024 * 1024
export const attachmentMime = z.enum(['image/jpeg', 'image/png', 'application/pdf', 'audio/ogg', 'audio/mpeg', 'audio/mp4'])
const account = z.union([z.literal('primary'), z.uuid()])
const cursor = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const attachmentInput = z.object({
  name: z.string().trim().min(1).max(120), mime: attachmentMime,
  base64: z.string().min(4).max(Math.ceil(maxAttachmentBytes / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict()
export type ChatAttachment = z.infer<typeof attachmentInput>

export function chatError(error: { code?: string; message?: string } | null) {
  if (!error) return
  if (error.code === '42501') throw new ApiError(403, 'No tenés permiso para esta conversación.')
  if (error.code === 'PT404') throw new ApiError(404, 'No encontramos la conversación, el lead o el archivo.')
  if (error.code === 'PT409') {
    const message = error.message === 'Contact unavailable'
      ? 'Este número no está disponible para enviar. Revisá el teléfono y las bajas del lead.'
      : 'La operación ya cambió. Actualizá la conversación.'
    throw new ApiError(409, message)
  }
  if (['22023','22021','22P02','23514'].includes(error.code ?? '')) throw new ApiError(422, 'Revisá el mensaje o el archivo adjunto.')
  throw new ApiError(503, 'No pudimos consultar las conversaciones. Volvé a intentar.')
}

export function createChatStore(client: SupabaseClient): ChatCommand {
  return async (action, data) => {
    const result = await client.rpc('koi_chat_command', { action, data })
    chatError(result.error)
    return result.data
  }
}

export function validAttachment(base64: string, mime: string) {
  if (base64.length > Math.ceil(maxAttachmentBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > maxAttachmentBytes || bytes.toString('base64') !== base64) return false
  switch (mime) {
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'application/pdf': return bytes.subarray(0, 5).toString() === '%PDF-'
    case 'audio/ogg': return bytes.subarray(0, 4).toString() === 'OggS'
    case 'audio/mp4': return bytes.subarray(4, 8).toString() === 'ftyp'
    case 'audio/mpeg': return bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    default: return false
  }
}

type MediaLookup = { instance: string; providerId: string }
export type ReadChatMedia = (lookup: MediaLookup) => Promise<string>
export type SyncChatHistory = (target: { instance: string; peer: string }, page: number) => Promise<{ more: boolean }>

export async function chatRoute(request: IncomingMessage, url: URL, command: ChatCommand, readBody: (limit?: number) => Promise<unknown>, readMedia?: ReadChatMedia, syncHistory?: SyncChatHistory) {
  const path = url.pathname.slice('/api/conversations'.length)
  if (path === '/accounts' && request.method === 'GET') return { status: 200, data: await command('accounts', {}) }
  if (path === '' && request.method === 'GET') {
    const input = z.object({
      search: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).max(10000).default(1),
      archived: z.enum(['true','false']).default('false'), unread: z.enum(['true','false']).default('false'), instanceId: account.optional(),
    }).strict().parse(Object.fromEntries(url.searchParams))
    return { status: 200, data: await command('list', input) }
  }
  if (path === '' && request.method === 'POST') {
    const input = z.object({ leadId: z.uuid(), instanceId: account }).strict().parse(await readBody())
    return { status: 200, data: await command('open', input) }
  }
  const match = /^\/([^/]+)(?:\/(read|messages|attachment|resolve|history))?$/.exec(path)
  if (!match) throw new ApiError(404, 'No encontramos esa operación.')
  const id = z.uuid().parse(match[1])
  if (request.method === 'GET' && !match[2]) {
    const before = cursor.optional().parse(url.searchParams.get('before') ?? undefined)
    return { status: 200, data: await command('detail', { id, before }) }
  }
  if (request.method === 'POST' && match[2] === 'history') {
    if (!syncHistory) throw new ApiError(503, 'No hay historial de WhatsApp disponible en esta conexión.')
    const { page } = z.object({ page: z.number().int().min(1).max(10000) }).strict().parse(await readBody())
    const target = z.object({ instance: z.string(), peer: z.string() }).parse(await command('history_target', { id }))
    return { status: 200, data: await syncHistory(target, page) }
  }
  if (request.method === 'GET' && match[2] === 'attachment') {
    const messageId = z.uuid().parse(url.searchParams.get('messageId'))
    const file = z.object({ filename: z.string().nullable(), mime: attachmentMime, base64: z.string().nullable(),
      instance: z.string(), providerId: z.string().nullable() }).parse(await command('attachment', { id, messageId }))
    const base64 = file.base64 ?? (readMedia && file.providerId ? await readMedia({ instance: file.instance, providerId: file.providerId }) : '')
    if (!validAttachment(base64, file.mime)) throw new ApiError(422, 'El archivo ya no está disponible o tiene un formato incompatible.')
    return { status: 200, data: { name: file.filename || 'Adjunto de WhatsApp', mime: file.mime, base64 } }
  }
  if (request.method === 'PATCH' && !match[2]) {
    const patch = z.object({ archived: z.boolean().optional(), assignedTo: z.uuid().nullable().optional() }).strict().parse(await readBody())
    return { status: 200, data: await command('update', { id, ...patch }) }
  }
  if (request.method === 'POST' && match[2] === 'read') {
    const { through } = z.object({ through: cursor }).strict().parse(await readBody())
    return { status: 200, data: await command('read', { id, through }) }
  }
  if (request.method === 'POST' && match[2] === 'resolve') {
    const { messageId } = z.object({ messageId: z.uuid() }).strict().parse(await readBody())
    return { status: 200, data: await command('resolve', { id, messageId }) }
  }
  if (request.method === 'POST' && match[2] === 'messages') {
    const { text, file } = z.object({ text: z.string().trim().max(4000), file: attachmentInput.optional() }).strict().parse(await readBody(6 * 1024 * 1024))
    const key = z.uuid().parse(request.headers['idempotency-key'])
    if (!text && !file) throw new ApiError(422, 'Escribí un mensaje o elegí un archivo.')
    if (file?.mime.startsWith('audio/') && text) throw new ApiError(422, 'Enviá el texto y el audio en mensajes separados.')
    if (file && !validAttachment(file.base64, file.mime)) throw new ApiError(422, 'El archivo no coincide con el formato indicado o supera 4 MiB.')
    const data = await command('send', { id, key, text, ...(file ? { mime: file.mime, fileName: file.name, base64: file.base64 } : {}) })
    return { status: 202, data }
  }
  throw new ApiError(404, 'No encontramos esa operación.')
}

export type ChatSendJob = { phone: string; text: string; mime: string | null; fileName: string | null; base64: string | null }
const providerId = z.object({ key: z.object({ id: z.string().min(1).max(200) }) })
export function createChatMedia(config: { url: string; apiKey: string }, request: typeof fetch = fetch) {
  const post = (path: string, body: object) => request(`${config.url}${path}`, {
    method: 'POST', headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
  })
  return {
    async read({ instance, providerId }: MediaLookup): Promise<string> {
      try {
        const response = await post(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, { message: { key: { id: providerId } } })
        if (!response.ok) { await response.body?.cancel(); throw new Error('Attachment unavailable') }
        return z.object({ base64: z.string() }).parse(await boundedProviderJson(response)).base64
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError(502, 'WhatsApp no pudo recuperar este archivo.')
      }
    },
    async history(instance: string, peer: string, page: number) {
      try {
        const response = await post(`/chat/findMessages/${encodeURIComponent(instance)}`, {
          where: { key: { remoteJid: peer, remoteJidAlt: peer } }, page, offset: 50,
        })
        if (!response.ok) { await response.body?.cancel(); throw new Error('History unavailable') }
        return z.object({ messages: z.object({ records: z.array(z.unknown()).max(50), pages: z.number().int().nonnegative() }) }).parse(await boundedProviderJson(response)).messages
      } catch {
        throw new ApiError(502, 'WhatsApp no pudo recuperar el historial de este chat.')
      }
    },
    async send(instance: string, job: ChatSendJob): Promise<SendOutcome> {
      if (!job.mime || !job.base64 || !validAttachment(job.base64, job.mime)) return { outcome: 'failed', reason: 'invalid_attachment' }
      const voice = job.mime.startsWith('audio/')
      const route = voice ? 'sendWhatsAppAudio' : 'sendMedia'
      const body = voice ? { number: job.phone, audio: job.base64 } : {
        number: job.phone, mediatype: job.mime.startsWith('image/') ? 'image' : 'document',
        mimetype: job.mime, fileName: job.fileName, caption: job.text, media: job.base64,
      }
      try {
        const response = await post(`/message/${route}/${encodeURIComponent(instance)}`, body)
        if (!response.ok) {
          await response.body?.cancel()
          return { outcome: [401,403,404].includes(response.status) ? 'failed' : 'unknown', reason: `provider_${response.status}` }
        }
        const result = providerId.safeParse(await response.json())
        return result.success ? { outcome: 'accepted', providerId: result.data.key.id } : { outcome: 'unknown', reason: 'invalid_response' }
      } catch {
        return { outcome: 'unknown', reason: 'network_or_timeout' }
      }
    },
  }
}

async function boundedProviderJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 6 * 1024 * 1024) { await reader.cancel(); throw new ApiError(413, 'La respuesta de WhatsApp supera el tamaño permitido.') }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
