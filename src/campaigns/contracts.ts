import { z } from 'zod'

export const campaignInput = z.object({
  name: z.string().trim().min(1).max(100), listId: z.uuid(),
  template: z.string().trim().min(1).max(4000),
  recipientIds: z.array(z.uuid()).max(5000).default([]),
  config: z.object({
    intervalSeconds: z.number().int().min(1).max(86400),
    perMinute: z.number().int().min(1).max(60), perHour: z.number().int().min(1).max(3600), perDay: z.number().int().min(1).max(10000),
    timezone: z.literal('America/Argentina/Tucuman'),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  }).strict().refine(value => value.startMinute < value.endMinute, 'La franja debe terminar después del inicio'),
}).strict()
export type CampaignInput = z.infer<typeof campaignInput>
export type CampaignCommand = (action: string, data: Record<string, unknown>) => Promise<unknown>
export type QueueJob = { id: string; campaign_id: string; phone: string; message: string; lease_token: string }
export type SendOutcome = { outcome: 'accepted'; providerId: string } | { outcome: 'failed' | 'unknown'; reason: string }
