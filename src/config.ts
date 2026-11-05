import { z } from 'zod'

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === '' ? undefined : value, schema.optional())
const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  KOI_APP_ORIGIN: z.url().refine(value => new URL(value).origin === value, 'Usá el origen sin path ni barra final'),
  KOI_SUPABASE_URL: z.url().refine(value => value === 'https://avqhjbrcbgqhelfkcist.supabase.co', 'Debe ser el proyecto Koi aprobado'),
  KOI_SUPABASE_PUBLISHABLE_KEY: z.string().startsWith('sb_publishable_').min(25),
  EVOLUTION_PUBLIC_URL: optional(z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  }, 'Usá HTTPS sin credenciales, path ni barra final')),
  EVOLUTION_API_KEY: optional(z.string().min(16).max(512).regex(/^[\x21-\x7e]+$/)),
  EVOLUTION_INSTANCE_NAME: optional(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)),
  KOI_EVOLUTION_WORKSPACE_ID: optional(z.uuid()),
}).superRefine((value, context) => {
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
