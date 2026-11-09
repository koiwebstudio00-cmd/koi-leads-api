import { z } from 'zod'
import { normalizePhone } from './contracts/imports.ts'

const text = z.string().trim().max(250)
export const leadInput = z.object({
  revision: z.number().int().nonnegative(),
  name: text, company: text, source: text,
  email: z.union([z.literal(''), z.email().max(250)]),
  phone: z.string().trim().max(40).transform((value, ctx) => {
    const result = normalizePhone(value, 'AR')
    if (result.error) { ctx.addIssue({ code: 'custom', message: result.error }); return z.NEVER }
    return result.phone
  }),
}).strict()
export type LeadInput = z.output<typeof leadInput>
