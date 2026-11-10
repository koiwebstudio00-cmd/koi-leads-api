import { conversationEvents } from '../conversation-events.ts'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ApiError } from '../store.ts'
import type { MachineCommand } from './machine-store.ts'

const envelope = z.object({ event: z.string().max(80), instance: z.string().max(100), date_time: z.string().max(80).optional(), data: z.unknown() })
const rowSchema = z.object({
  keyId: z.string().max(200).optional(), fromMe: z.boolean().optional(), status: z.union([z.string(),z.number()]).optional(), state: z.string().optional(),
  key: z.object({ id: z.string().max(200).optional(), fromMe: z.boolean().optional(), remoteJid: z.string().max(100).optional() }).optional(),
  message: z.object({ conversation: z.string().max(10000).optional(), extendedTextMessage: z.object({ text: z.string().max(10000).optional() }).optional() }).optional(),
})
export function normalizeWebhook(body: unknown, expectedInstance: string): Record<string, unknown>[] {
  const parsed = envelope.parse(body)
  if (parsed.instance !== expectedInstance) throw new ApiError(403, 'Instancia no autorizada.')
  const event = parsed.event.toLowerCase().replaceAll('_','.')
  const rows = Array.isArray(parsed.data) ? parsed.data.slice(0,100) : [parsed.data]
  if (Array.isArray(parsed.data) && parsed.data.length > 100) throw new ApiError(413, 'Demasiados eventos.')
  const result: Record<string, unknown>[] = []
  for (const raw of rows) {
    const item = rowSchema.safeParse(raw)
    if (!item.success) continue
    const row = item.data
    let data: Record<string, unknown> | undefined
    if (event === 'messages.update' && row.fromMe !== false) {
      const statuses: Record<string,string> = { SERVER_ACK:'sent',DELIVERY_ACK:'delivered',READ:'read',PLAYED:'read',ERROR:'error','0':'error','2':'sent','3':'delivered','4':'read','5':'read' }
      const delivery = statuses[String(row.status)]
      const providerId = row.keyId ?? row.key?.id
      if (delivery && providerId) data = { kind:'receipt', providerId, delivery }
    } else if (event === 'connection.update' && ['open','close','connecting'].includes(row.state ?? '')) {
      data = { kind:'connection',state:row.state,at:parsed.date_time ?? '' }
    } else if (event === 'messages.upsert' && row.key?.fromMe === false) {
      const match = /^([1-9][0-9]{9,14})@s\.whatsapp\.net$/.exec(row.key.remoteJid ?? '')
      const text = (row.message?.conversation ?? row.message?.extendedTextMessage?.text ?? '').trim().toLocaleLowerCase('es')
      if (match && row.key.id && ['baja','stop','no me contacten','no me escriban más','no me escriban mas'].includes(text)) data = { kind:'optout',phone:match[1],providerId:row.key.id }
    }
    if (data) {
      const eventKey = createHash('sha256').update(JSON.stringify({ instance:expectedInstance,...data })).digest('hex')
      result.push({ instance:expectedInstance,eventKey,...data })
    }
  }
  return result
}
export function createWebhook(secret: string, instance: string, command: MachineCommand, inbox = false) {
  return async (header: string | string[] | undefined, body: () => Promise<unknown>) => {
    const actual = typeof header === 'string' ? Buffer.from(header) : Buffer.alloc(0)
    const expected = Buffer.from(secret)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, 'Webhook no autorizado.')
    const payload = await body()
    const parsed = envelope.parse(payload)
    const events = !inbox || parsed.instance === instance ? normalizeWebhook(payload, instance) : []
    for (const event of events) await command('ingest', event)
    if (!inbox) return { received: events.length }
    const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data]
    if (rows.length > 100) throw new ApiError(413, 'Demasiados eventos.')
    const messages = conversationEvents(parsed.event.toLowerCase().replaceAll('_','.'), parsed.instance, rows)
    for (const event of messages) await command('chat_ingest', event)
    return { received: events.length + messages.length }
  }
}
