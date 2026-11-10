import { z } from 'zod'

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === '' ? undefined : value, schema.optional())
const configSchema = z.object({
  KOI_WEBHOOK_DATABASE_URL: optional(z.string().min(1)),
  KOI_EVOLUTION_WEBHOOK_SECRET: optional(z.string().min(32).max(256)),
  KOI_DATABASE_CA_FILE: optional(z.string().min(1)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  KOI_APP_ORIGIN: z.url().refine(value => new URL(value).origin === value, 'Usá el origen sin path ni barra final'),
  KOI_SUPABASE_URL: z.url().refine(value => value === 'https://avqhjbrcbgqhelfkcist.supabase.co', 'Debe ser el proyecto Koi aprobado'),
  KOI_SUPABASE_PUBLISHABLE_KEY: z.string().startsWith('sb_publishable_').min(25),
  KOI_RELAY_CHAT_MEDIA: optional(z.enum(['true', 'false'])),
  EVOLUTION_PUBLIC_URL: optional(z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  }, 'Usá HTTPS sin credenciales, path ni barra final')),
  EVOLUTION_API_KEY: optional(z.string().min(16).max(512).regex(/^[\x21-\x7e]+$/)),
  EVOLUTION_INSTANCE_NAME: optional(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)),
  KOI_EVOLUTION_WORKSPACE_ID: optional(z.uuid()),
}).superRefine((value, context) => {
  if (value.KOI_RELAY_CHAT_MEDIA === 'true' && (!URL.canParse(value.KOI_APP_ORIGIN) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value.KOI_APP_ORIGIN).hostname))) {
    context.addIssue({ code: 'custom', path: ['KOI_RELAY_CHAT_MEDIA'], message: 'Disponible solo para la app local' })
  }
  if (Boolean(value.KOI_WEBHOOK_DATABASE_URL) !== Boolean(value.KOI_EVOLUTION_WEBHOOK_SECRET) || (value.KOI_WEBHOOK_DATABASE_URL && !value.EVOLUTION_INSTANCE_NAME)) context.addIssue({ code: 'custom', path: ['KOI_WEBHOOK_DATABASE_URL'], message: 'Completá la configuración del webhook' })
  const fields = ['EVOLUTION_PUBLIC_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE_NAME', 'KOI_EVOLUTION_WORKSPACE_ID'] as const
  if (fields.some(field => value[field] !== undefined)) {
    for (const field of fields) if (!value[field]) context.addIssue({ code: 'custom', path: [field], message: 'Completá la conexión Evolution' })
  }
})

export function readConfig(input: Record<string, string | undefined>) {
  const result = configSchema.safeParse(input)
  if (!result.success) {
    // Nunca incluir valores de entorno en errores de arranque.
    throw new Error(`Configuración inválida: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
  }
  return result.data
}
