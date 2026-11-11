import { z } from 'zod'
import { attachmentMime } from './conversations.ts'

const peerSchema = z.string().regex(/^\d{1,25}@(s\.whatsapp\.net|lid)$/)
const phoneJid = /^([1-9]\d{9,14})@s\.whatsapp\.net$/
const providerKey = z.string().min(1).max(200)
const milliseconds = z.number().int().min(1).max(4102444800000)
const protobufLong = z.object({ low: z.number().int().min(-2147483648).max(2147483647), high: z.number().int().min(0).max(955) })
const reactionTimestamp = z.union([
  z.coerce.number().pipe(milliseconds),
  protobufLong.transform(({low,high}) => high * 2 ** 32 + (low >>> 0)).pipe(milliseconds),
])
const quoteSchema = z.object({ stanzaId: providerKey, quotedMessage: z.unknown().optional() })
const mediaSchema = z.object({ contextInfo: z.unknown().optional(), mimetype: z.string().optional(), fileName: z.string().max(500).optional(), caption: z.string().max(10000).optional() })
const content = z.object({
  conversation: z.string().max(10000).optional(), extendedTextMessage: z.object({ text: z.string().max(10000), contextInfo: z.unknown().optional() }).optional(),
  imageMessage: mediaSchema.optional(), documentMessage: mediaSchema.optional(), audioMessage: mediaSchema.optional(), stickerMessage: mediaSchema.optional(),
  reactionMessage: z.object({ key: z.object({ id: providerKey }), text: z.string().max(64).nullish(), senderTimestampMs: z.unknown() }).optional(),
})
const message = z.object({
  key: z.object({ id: z.string().min(1).max(200), fromMe: z.boolean(), remoteJid: peerSchema, remoteJidAlt: peerSchema.optional() }),
  pushName: z.string().max(250).nullish(), messageTimestamp: z.coerce.number().int().min(0).max(4102444800).optional(),
  message: z.unknown(), contextInfo: z.unknown().optional(),
})
const receipt = z.object({ keyId: z.string().max(200).optional(), key: z.object({ id: z.string().max(200), fromMe: z.boolean().optional() }).optional(),
  fromMe: z.boolean().optional(), status: z.union([z.string(),z.number()]) })
const statuses: Record<string,string> = { SERVER_ACK:'sent', DELIVERY_ACK:'delivered', READ:'read', PLAYED:'read', ERROR:'error', '0':'error', '2':'sent', '3':'delivered', '4':'read', '5':'read' }

export function conversationEvents(event: string, instance: string, rows: unknown[]): Record<string, unknown>[] {
  if (event === 'messages.update') return rows.flatMap<Record<string, unknown>>(raw => {
    const parsed = receipt.safeParse(raw)
    if (!parsed.success || parsed.data.fromMe === false || parsed.data.key?.fromMe === false) return []
    const providerId = parsed.data.keyId ?? parsed.data.key?.id
    const delivery = statuses[String(parsed.data.status)]
    return providerId && delivery ? [{ instance, kind: 'receipt', providerId, delivery }] : []
  })
  if (event !== 'messages.upsert' && event !== 'send.message' && event !== 'messages.set') return []
  return rows.flatMap<Record<string, unknown>>(raw => {
    const parsed = message.safeParse(raw)
    if (!parsed.success) return []
    const { key, messageTimestamp, pushName } = parsed.data
    const wrapper = z.object({ ephemeralMessage: z.object({ message: z.unknown() }).optional(), documentWithCaptionMessage: z.object({ message: z.unknown() }).optional() }).safeParse(parsed.data.message)
    const body = content.safeParse(wrapper.data?.ephemeralMessage?.message ?? wrapper.data?.documentWithCaptionMessage?.message ?? parsed.data.message)
    if (!body.success) return []
    const canonical = phoneJid.test(key.remoteJid) ? key.remoteJid : key.remoteJidAlt ?? key.remoteJid
    const reaction = body.data.reactionMessage
    if (reaction) {
      const timestamp = reactionTimestamp.safeParse(reaction.senderTimestampMs)
      return [{ instance, kind: 'reaction', providerId: key.id, peer: canonical, outbound: key.fromMe,
        targetId: reaction.key.id, emoji: reaction.text ?? '', occurredMs: timestamp.data ?? (messageTimestamp ?? 0) * 1000 }]
    }
    const sticker = body.data.stickerMessage
    const media = body.data.imageMessage ?? body.data.documentMessage ?? body.data.audioMessage ?? sticker
    const quote = quoteSchema.safeParse(parsed.data.contextInfo ?? body.data.extendedTextMessage?.contextInfo ?? media?.contextInfo)
    const quoted = quote.success ? content.safeParse(quote.data.quotedMessage).data : undefined
    const quoteText = quoted?.conversation ?? quoted?.extendedTextMessage?.text ?? quoted?.imageMessage?.caption ?? quoted?.documentMessage?.caption
      ?? (quoted?.stickerMessage ? 'Sticker' : quoted?.imageMessage ? 'Imagen' : quoted?.audioMessage ? 'Audio' : quoted?.documentMessage ? 'Documento' : undefined)
    const supportedMime = attachmentMime.safeParse(sticker ? 'image/webp' : media?.mimetype?.split(';')[0])
    const text = body.data.conversation ?? body.data.extendedTextMessage?.text ?? media?.caption ?? ''
    if (!text && !media) return []
    return [{ instance, kind: 'message', providerId: key.id, peer: canonical, phone: phoneJid.exec(canonical)?.[1],
      quoteId: quote.success ? quote.data.stanzaId : undefined, quoteText: quoteText?.slice(0, 250),
      outbound: key.fromMe, historical: event === 'messages.set', text: text || (supportedMime.success ? '' : 'Adjunto de WhatsApp'),
      name: key.fromMe ? undefined : pushName, sentAt: messageTimestamp ? new Date(messageTimestamp * 1000).toISOString() : undefined,
      fileName: supportedMime.success ? media?.fileName?.slice(0,120) || (sticker ? 'Sticker.webp' : body.data.audioMessage ? 'Audio de WhatsApp' : body.data.imageMessage ? 'Imagen de WhatsApp' : 'Documento de WhatsApp') : undefined,
      mime: supportedMime.success ? supportedMime.data : undefined }]
  })
}
