import {sensitiveServices} from './sensitive.ts'
import {readVaultKeys} from './vault-crypto.ts'
import { createInboxReadMedia } from './inbox/media.ts'
import { createInboxMachine } from './inbox/machine.ts'
import { createZernioClient } from './inbox/provider.ts'
import { createInboxService } from './inbox/service.ts'
import { createInboxWebhook } from './inbox/webhook.ts'
import { createChatMedia, createChatMediaRelay, type SyncChatHistory } from './conversations.ts'
import { conversationEvents } from './conversation-events.ts'
import { createWhatsAppManager } from './whatsapp.ts'
import { createApp } from './app.ts'
import { createStatisticsService } from './statistics/service.ts'
import { createAdsStatistics } from './statistics/ads.ts'
import { createInstagramStatistics } from './statistics/instagram.ts'
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
const webhook = machine && config.KOI_EVOLUTION_WEBHOOK_SECRET && config.EVOLUTION_INSTANCE_NAME ? createWebhook(config.KOI_EVOLUTION_WEBHOOK_SECRET, config.EVOLUTION_INSTANCE_NAME, machine.command, true) : undefined
const chatProvider = config.EVOLUTION_PUBLIC_URL && config.EVOLUTION_API_KEY
  ? createChatMedia({ url: config.EVOLUTION_PUBLIC_URL, apiKey: config.EVOLUTION_API_KEY }) : undefined
const syncChatHistory: SyncChatHistory | undefined = machine && chatProvider ? async ({ instance, peer }, page) => {
  const history = await chatProvider.history(instance, peer, page)
  const messages = conversationEvents('messages.set', instance, history.records).filter(event => event.peer === peer)
  if (messages.length) await machine.command('chat_history', { instance, events: messages })
  return { more: page < history.pages }
} : undefined
const inboxMachine=config.KOI_INBOX_GATEWAY_DATABASE_URL?createInboxMachine(config.KOI_INBOX_GATEWAY_DATABASE_URL,config.KOI_DATABASE_CA_FILE):undefined
const inbox=inboxMachine?createInboxService({command:inboxMachine.command,provider:createZernioClient(config.ZERNIO_API_KEY!),
  workspaceId:config.KOI_ZERNIO_WORKSPACE_ID!,profileId:config.ZERNIO_PROFILE_ID!,origin:config.KOI_APP_ORIGIN}):undefined
const inboxWebhook=inboxMachine?createInboxWebhook(config.ZERNIO_WEBHOOK_SECRET!,inboxMachine.command):undefined
const inboxMedia=config.ZERNIO_API_KEY?createInboxReadMedia(createZernioClient(config.ZERNIO_API_KEY),config.ZERNIO_API_KEY):undefined
const statistics = inboxMachine && config.ZERNIO_API_KEY && config.ZERNIO_PROFILE_ID && config.KOI_ZERNIO_WORKSPACE_ID
  ? createStatisticsService({
      command: inboxMachine.statistics, origin: config.KOI_APP_ORIGIN, workspaceId:config.KOI_ZERNIO_WORKSPACE_ID,
      profileId:config.ZERNIO_PROFILE_ID, ads:createAdsStatistics(config.ZERNIO_API_KEY,config.ZERNIO_PROFILE_ID),
      instagram:createInstagramStatistics(config.ZERNIO_API_KEY),
    })
  : undefined
const sensitive=sensitiveServices(config.KOI_SUPABASE_URL,config.KOI_SUPABASE_PUBLISHABLE_KEY,readVaultKeys(process.env.KOI_VAULT_KEYS,process.env.KOI_VAULT_KEY_VERSION))
const server = createApp({ sensitive, statistics, inboxRichEnabled:config.KOI_INBOX_RICH_ENABLED==='true',inboxSendEnabled:config.KOI_INBOX_SEND_ENABLED==='true',inbox,inboxWebhook,inboxMedia, origin: config.KOI_APP_ORIGIN, authorize: createAuthorizer(config.KOI_SUPABASE_URL, config.KOI_SUPABASE_PUBLISHABLE_KEY), evolution, webhook, whatsapp, readChatMedia: chatProvider?.read, relayChatMedia: config.KOI_RELAY_CHAT_MEDIA === 'true' ? createChatMediaRelay() : undefined, syncChatHistory })
server.listen(config.PORT, '0.0.0.0', () => console.log(`Koi API listening on ${config.PORT}`))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => { void Promise.all([machine?.close(),inboxMachine?.close()]).finally(() => process.exit(0)) })
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
