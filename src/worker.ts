import { createChatMedia } from './conversations.ts'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { createMachineStore } from './campaigns/machine-store.ts'
import { workerCycle } from './campaigns/worker-cycle.ts'
import { createTextSender } from './campaigns/evolution-send.ts'
import { createEvolutionConnection } from './evolution.ts'

const parsed = z.object({
  KOI_WORKER_DATABASE_URL: z.string().min(1), KOI_DATABASE_CA_FILE: z.string().optional(),
  EVOLUTION_PUBLIC_URL: z.url().refine(s => new URL(s).protocol === 'https:' && new URL(s).origin === s),
  EVOLUTION_API_KEY: z.string().min(16), EVOLUTION_INSTANCE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  KOI_EVOLUTION_WORKSPACE_ID: z.uuid(), KOI_SEND_ENABLED: z.enum(['true','false']).default('false'),
  KOI_WORKER_POLL_MS: z.coerce.number().int().min(1000).max(30000).default(3000),
}).safeParse(process.env)
if (!parsed.success) throw new Error(`Configuración worker inválida: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
const config = parsed.data
const machine = createMachineStore(config.KOI_WORKER_DATABASE_URL, config.KOI_DATABASE_CA_FILE)
const connection = createEvolutionConnection({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instanceName: config.EVOLUTION_INSTANCE_NAME, workspaceId: config.KOI_EVOLUTION_WORKSPACE_ID })
const send = createTextSender({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instance: config.EVOLUTION_INSTANCE_NAME })
const media = createChatMedia({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY })
const chat = {
  connected: async (instance: string) => instance === config.EVOLUTION_INSTANCE_NAME ? (await connection.status()).state === 'connected'
    : (await createEvolutionConnection({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instanceName: instance, workspaceId: config.KOI_EVOLUTION_WORKSPACE_ID }).status()).state === 'connected',
  send: (instance: string, job: import('./conversations.ts').ChatSendJob) => job.mime ? media.send(instance, job)
    : createTextSender({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instance })(job.phone, job.text),
}
const controller = new AbortController()
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => controller.abort())
const workerId = randomUUID()
let failures = 0
console.log(JSON.stringify({ event: 'worker_started', workerId, sendingEnabled: config.KOI_SEND_ENABLED === 'true' }))
while (!controller.signal.aborted) {
  try {
    await workerCycle({ command: machine.command, instance: config.EVOLUTION_INSTANCE_NAME, workerId, enabled: config.KOI_SEND_ENABLED === 'true', signal: controller.signal, connected: async () => (await connection.status()).state === 'connected', send, chat })
    await writeFile('/tmp/koi-worker-heartbeat', String(Date.now()), { mode: 0o600 })
    failures = 0
  } catch {
    failures++
    console.error(JSON.stringify({ event: 'worker_cycle_failed', workerId, consecutiveFailures: failures }))
  }
  await sleep(Math.min(30000, config.KOI_WORKER_POLL_MS * 2 ** Math.min(failures, 4)), undefined, { signal: controller.signal }).catch(() => {})
}
await machine.close()
