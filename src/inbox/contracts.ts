import { z } from 'zod'

// Inbox v1 deliberately excludes EvoAPI and future web transports.
export const inboxChannel = z.enum(['whatsapp', 'instagram'])
const timestamp = z.iso.datetime({ offset: true })
const externalId = z.string().trim().min(1).max(200)
export const inboxAccount = z.object({
  id: z.uuid(), workspaceId: z.uuid(), provider: z.literal('zernio'),
  channel: inboxChannel, externalId, label: z.string().trim().min(1).max(100),
  address: z.string().max(250).nullable(),
  state: z.enum(['pending', 'connected', 'disconnected', 'error']),
}).strict()

export const inboxIdentity = z.object({
  id: z.uuid(), accountId: z.uuid(), leadId: z.uuid(), externalId,
  displayName: z.string().max(250), username: z.string().max(250).nullable(),
}).strict()

export const replyWindow = z.object({
  canReply: z.boolean(),
  reason: z.enum(['open', 'expired', 'missing_inbound', 'invalid_inbound', 'disconnected']),
  expiresAt: timestamp.nullable(), evaluatedAt: timestamp,
}).strict()

export const inboxConversation = z.object({
  id: z.uuid(), accountId: z.uuid(), channel: inboxChannel, leadId: z.uuid(),
  externalId, assignedTo: z.uuid().nullable(), archived: z.boolean(),
  lastInboundAt: timestamp.nullable(), updatedAt: timestamp,
  unread: z.number().int().nonnegative(), pendingReply: z.boolean(),
  replyWindow,
}).strict()

export const inboxAttachment = z.object({
  id: z.uuid(), kind: z.enum(['image', 'video', 'audio', 'document']),
  name: z.string().max(250), mime: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
}).strict()
export const inboxMessage = z.object({
  id: z.uuid(), conversationId: z.uuid(), externalId: externalId.nullable(),
  direction: z.enum(['in', 'out']), body: z.string().max(10000),
  sentAt: timestamp, historical: z.boolean(), actorId: z.uuid().nullable(),
  status: z.enum(['received', 'queued', 'sending', 'accepted', 'failed', 'unknown', 'closed']),
  delivery: z.enum(['sent', 'delivered', 'read', 'error']).nullable(),
  attachments: z.array(inboxAttachment).max(10),
}).strict()

// No client-supplied recipient, account, author, timestamp, template or message tag.
// The route resolves the account/contact from the authorized conversation.
export const inboxSendInput = z.object({
  text: z.string().trim().max(10000).default(''),
  attachmentIds: z.array(z.uuid()).max(10).default([]),
}).strict().refine(value => value.text.length > 0 || value.attachmentIds.length > 0,
  'Escribí un mensaje o adjuntá un archivo.')
  .refine(value => new Set(value.attachmentIds).size === value.attachmentIds.length,
    'Un adjunto no puede repetirse.')
export const inboxRequestKey = z.uuid()
export const inboxIndexQuery = z.object({
  after: z.uuid().optional(),
  ids: z.array(z.uuid()).min(1).max(100).optional(),
}).strict().refine(value => !(value.after && value.ids), 'Elegí cursor o identificadores.')
export const inboxMessageQuery = z.object({
  before: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict()
export const inboxAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('archive'), archived: z.boolean() }).strict(),
  z.object({ action: z.literal('assign'), assignedTo: z.uuid().nullable() }).strict(),
  z.object({ action: z.literal('read'), throughMessageId: z.uuid(), revision:z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('unread') }).strict(),
])
export type InboxAccount = z.infer<typeof inboxAccount>
export type InboxConversation = z.infer<typeof inboxConversation>
export type InboxMessage = z.infer<typeof inboxMessage>
export type InboxReplyWindow = z.infer<typeof replyWindow>
