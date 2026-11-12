import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createMachineStore } from './campaigns/machine-store.ts'
import { createEvolutionConnection } from './evolution.ts'
import { createTextSender } from './campaigns/evolution-send.ts'
import { createChatMedia, type ChatSendJob } from './conversations.ts'

export function createWorkerRuntime(lane: 'chat' | 'campaign') {
  const parsed = z.object({
    KOI_WORKER_DATABASE_URL: z.string().optional(), KOI_CHAT_WORKER_DATABASE_URL: z.string().optional(),
    KOI_CHAT_LISTEN_DATABASE_URL: z.string().optional(), KOI_DATABASE_CA_FILE: z.string().optional(),
    EVOLUTION_PUBLIC_URL: z.url().refine(s => new URL(s).protocol === 'https:' && new URL(s).origin === s),
    EVOLUTION_API_KEY: z.string().min(16), EVOLUTION_INSTANCE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    KOI_EVOLUTION_WORKSPACE_ID: z.uuid(), KOI_SEND_ENABLED: z.enum(['true','false']).default('false'),
    KOI_CHAT_SEND_ENABLED: z.enum(['true','false']).default('false'),
    KOI_WORKER_POLL_MS: z.coerce.number().int().min(1000).max(30000).default(3000),
  }).safeParse(process.env)
  if (!parsed.success) throw new Error(`Configuración worker inválida: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
  const config = parsed.data
  const connectionString = lane === 'chat' ? config.KOI_CHAT_WORKER_DATABASE_URL : config.KOI_WORKER_DATABASE_URL
  if (!connectionString) throw new Error(`Falta la conexión de base de datos del worker ${lane}.`)
  const machine = createMachineStore(connectionString, config.KOI_DATABASE_CA_FILE)
  const media = createChatMedia({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY })
  const connections = new Map<string, ReturnType<typeof createEvolutionConnection>>()
  function connection(instance: string) {
    let value = connections.get(instance)
    if (!value) {
      value = createEvolutionConnection({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instanceName: instance, workspaceId: config.KOI_EVOLUTION_WORKSPACE_ID })
      connections.set(instance, value)
    }
    return value
  }
  const controller = new AbortController()
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => controller.abort())
  const enabled = (lane === 'chat' ? config.KOI_CHAT_SEND_ENABLED : config.KOI_SEND_ENABLED) === 'true'
  const workerId = randomUUID()
  console.log(JSON.stringify({ event: 'worker_started', lane, workerId, sendingEnabled: enabled }))
  return {
    config, machine, controller, workerId, enabled, connectionString,
    connected: async (instance: string) => (await connection(instance).status()).state === 'connected',
    send: (instance: string, job: ChatSendJob) => job.mime ? media.send(instance, job)
      : createTextSender({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instance })(job.phone, job.text),
  }
}
