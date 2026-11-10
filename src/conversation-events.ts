import { z } from 'zod'
import { attachmentMime } from './conversations.ts'

const peerSchema = z.string().regex(/^\d{1,25}@(s\.whatsapp\.net|lid)$/)
const phoneJid = /^([1-9]\d{9,14})@s\.whatsapp\.net$/
const mediaSchema = z.object({ mimetype: z.string().optional(), fileName: z.string().max(500).optional(), caption: z.string().max(10000).optional() })
const content = z.object({
  conversation: z.string().max(10000).optional(), extendedTextMessage: z.object({ text: z.string().max(10000) }).optional(),
  imageMessage: mediaSchema.optional(), documentMessage: mediaSchema.optional(), audioMessage: mediaSchema.optional(),
})
const message = z.object({
  key: z.object({ id: z.string().min(1).max(200), fromMe: z.boolean(), remoteJid: peerSchema, remoteJidAlt: peerSchema.optional() }),
  pushName: z.string().max(250).optional(), messageTimestamp: z.coerce.number().int().min(0).max(4102444800).optional(),
  message: z.unknown(),
})
const receipt = z.object({ keyId: z.string().max(200).optional(), key: z.object({ id: z.string().max(200), fromMe: z.boolean().optional() }).optional(),
  fromMe: z.boolean().optional(), status: z.union([z.string(),z.number()]) })
const statuses: Record<string,string> = { SERVER_ACK:'sent', DELIVERY_ACK:'delivered', READ:'read', PLAYED:'read', ERROR:'error', '0':'error', '2':'sent', '3':'delivered', '4':'read', '5':'read' }

export function conversationEvents(event: string, instance: string, rows: unknown[]): Record<string, unknown>[] {
  if (event === 'messages.update') return rows.flatMap(raw => {
    const parsed = receipt.safeParse(raw)
    if (!parsed.success || parsed.data.fromMe === false || parsed.data.key?.fromMe === false) return []
    const providerId = parsed.data.keyId ?? parsed.data.key?.id
    const delivery = statuses[String(parsed.data.status)]
    return providerId && delivery ? [{ instance, kind: 'receipt', providerId, delivery }] : []
  })
  if (event !== 'messages.upsert' && event !== 'send.message' && event !== 'messages.set') return []
  return rows.flatMap(raw => {
    const parsed = message.safeParse(raw)
    if (!parsed.success) return []
    const { key, messageTimestamp, pushName } = parsed.data
    const wrapper = z.object({ ephemeralMessage: z.object({ message: z.unknown() }).optional(), documentWithCaptionMessage: z.object({ message: z.unknown() }).optional() }).safeParse(parsed.data.message)
    const body = content.safeParse(wrapper.data?.ephemeralMessage?.message ?? wrapper.data?.documentWithCaptionMessage?.message ?? parsed.data.message)
    if (!body.success) return []
    const media = body.data.imageMessage ?? body.data.documentMessage ?? body.data.audioMessage
    const supportedMime = attachmentMime.safeParse(media?.mimetype?.split(';')[0])
    const text = body.data.conversation ?? body.data.extendedTextMessage?.text ?? media?.caption ?? ''
    if (!text && !media) return []
    const canonical = phoneJid.test(key.remoteJid) ? key.remoteJid : key.remoteJidAlt ?? key.remoteJid
    return [{ instance, kind: 'message', providerId: key.id, peer: canonical, phone: phoneJid.exec(canonical)?.[1],
      outbound: key.fromMe, historical: event === 'messages.set', text: text || (supportedMime.success ? '' : 'Adjunto de WhatsApp'),
      name: key.fromMe ? undefined : pushName, sentAt: messageTimestamp ? new Date(messageTimestamp * 1000).toISOString() : undefined,
      fileName: supportedMime.success ? media?.fileName?.slice(0,120) || (body.data.audioMessage ? 'Audio de WhatsApp' : body.data.imageMessage ? 'Imagen de WhatsApp' : 'Documento de WhatsApp') : undefined,
      mime: supportedMime.success ? supportedMime.data : undefined }]
  })
}
