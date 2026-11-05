import { createApp } from './app.ts'
import { readConfig } from './config.ts'
import { createAuthorizer } from './store.ts'
import { createEvolutionConnection } from './evolution.ts'

const config = readConfig(process.env)
const evolution = config.EVOLUTION_PUBLIC_URL && config.EVOLUTION_API_KEY && config.EVOLUTION_INSTANCE_NAME && config.KOI_EVOLUTION_WORKSPACE_ID
  ? createEvolutionConnection({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY, instanceName: config.EVOLUTION_INSTANCE_NAME, workspaceId: config.KOI_EVOLUTION_WORKSPACE_ID })
  : undefined
const server = createApp({ origin: config.KOI_APP_ORIGIN, authorize: createAuthorizer(config.KOI_SUPABASE_URL, config.KOI_SUPABASE_PUBLISHABLE_KEY), evolution })
server.listen(config.PORT, '0.0.0.0', () => console.log(`Koi API listening on ${config.PORT}`))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
