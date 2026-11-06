import { createWhatsAppManager } from './whatsapp.ts'
import { createApp } from './app.ts'
import { readConfig } from './config.ts'
import { createAuthorizer } from './store.ts'
import { createEvolutionConnection } from './evolution.ts'

import { createMachineStore } from './campaigns/machine-store.ts'
import { createWebhook } from './campaigns/webhook.ts'

const config = readConfig(process.env)
const evolution = config.EVOLUTION_PUBLIC_URL && config.EVOLUTION_API_KEY && config.EVOLUTION_INSTANCE_NAME && config.KOI_EVOLUTION_WORKSPACE_ID
  ? createEvolutionConnection({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instanceName: config.EVOLUTION_INSTANCE_NAME, workspaceId: config.KOI_EVOLUTION_WORKSPACE_ID })
  : undefined
const whatsapp = evolution ? createWhatsAppManager({ url: config.EVOLUTION_PUBLIC_URL!, apiKey: config.EVOLUTION_API_KEY!, instanceName: config.EVOLUTION_INSTANCE_NAME!, workspaceId: config.KOI_EVOLUTION_WORKSPACE_ID! }) : undefined
const machine = config.KOI_WEBHOOK_DATABASE_URL ? createMachineStore(config.KOI_WEBHOOK_DATABASE_URL, config.KOI_DATABASE_CA_FILE) : undefined
const webhook = machine && config.KOI_EVOLUTION_WEBHOOK_SECRET && config.EVOLUTION_INSTANCE_NAME ? createWebhook(config.KOI_EVOLUTION_WEBHOOK_SECRET, config.EVOLUTION_INSTANCE_NAME, machine.command) : undefined
const server = createApp({ origin: config.KOI_APP_ORIGIN, authorize: createAuthorizer(config.KOI_SUPABASE_URL, config.KOI_SUPABASE_PUBLISHABLE_KEY), evolution, webhook, whatsapp })
server.listen(config.PORT, '0.0.0.0', () => console.log(`Koi API listening on ${config.PORT}`))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => { void (machine?.close() ?? Promise.resolve()).finally(() => process.exit(0)) })
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
