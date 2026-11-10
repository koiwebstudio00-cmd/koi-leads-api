import { chatRoute, type ReadChatMedia, type RelayChatMedia, type SyncChatHistory } from './conversations.ts'
import { crmRoute } from './crm.ts'
import { leadInput } from './lead-input.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { WhatsAppManager } from './whatsapp.ts'
import { campaignRoute } from './campaigns/routes.ts'
import { z } from 'zod'
import { ApiError, type Authorize } from './store.ts'
import { parseInWorker, parseOptionsSchema } from './import-service.ts'
import { IMPORT_LIMITS } from './contracts/imports.ts'
import type { EvolutionConnection } from './evolution.ts'

const inputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
}).strict()

async function readBody(request: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new ApiError(415, 'Se requiere contenido JSON.')
  const body = await readBytes(request, maxBytes)
  try { return JSON.parse(body.toString('utf8')) as unknown }
  catch { throw new ApiError(400, 'El contenido no es JSON válido.') }
}
async function readBytes(request: IncomingMessage, maxBytes: number) {
  if (Number(request.headers['content-length']) > maxBytes) throw new ApiError(413, 'La solicitud es demasiado grande.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > maxBytes) throw new ApiError(413, 'La solicitud es demasiado grande.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function createApp(options: { authorize: Authorize; origin: string; whatsapp?: WhatsAppManager; readChatMedia?: ReadChatMedia; relayChatMedia?: RelayChatMedia; syncChatHistory?: SyncChatHistory; evolution?: EvolutionConnection; webhook?: (header: string | string[] | undefined, body: () => Promise<unknown>) => Promise<unknown> }) {
  let uploads = 0
  const server = createServer(async (request, response) => {
    const requestId = randomUUID()
    response.setHeader('X-Request-Id', requestId)
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Vary', 'Origin')
    const send = (status: number, data: unknown) => reply(response, status, data)
    try {
      const origin = request.headers.origin
      if (origin && origin !== options.origin) throw new ApiError(403, 'Origen no permitido.')
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
        response.writeHead(204); response.end(); return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (path === '/health' && request.method === 'GET') { send(200, { status: 'ok', service: 'koi-api', capabilities: ['imports', 'campaigns-v1', 'whatsapp-instances-v1'] }); return }
      if (path === '/api/webhooks/evolution' && request.method === 'POST') {
        if (!options.webhook) throw new ApiError(503, 'Webhook no configurado.')
        send(200, await options.webhook(request.headers['x-koi-webhook-secret'], () => readBody(request, 262144))); return
      }
      const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1]
      if (!token) throw new ApiError(401, 'Ingresá para continuar.')
      const store = await options.authorize(token)
      if (path === '/api/integrations/evolution/status' && request.method === 'GET') {
        if (!options.evolution) { send(200, { state: 'not_configured', instanceName: null, checkedAt: null }); return }
        if (store.membership.workspace_id !== options.evolution.workspaceId) throw new ApiError(403, 'Esta conexión no pertenece a tu espacio.')
        send(200, await options.evolution.status()); return
      }
      if (path === '/api/integrations/evolution/instances' || path.startsWith('/api/integrations/evolution/instances/')) {
        if (!options.whatsapp) throw new ApiError(503, 'Gestión de WhatsApp no configurada.')
        const match = /^\/api\/integrations\/evolution\/instances(?:\/([^/]+)\/(connect|restart|disconnect))?$/.exec(path)
        if (!match) throw new ApiError(404, 'Operación no encontrada.')
        if (!match[1] && request.method === 'GET') { send(200, await options.whatsapp.list(store)); return }
        if (request.method === 'POST') {
          if (store.membership.role !== 'admin') throw new ApiError(403, 'Solo un administrador puede gestionar conexiones.')
          if (!match[1]) {
            const body=z.object({label:z.string().trim().min(1).max(60)}).strict().parse(await readBody(request))
            send(201, await options.whatsapp.create(store,body.label,z.uuid().parse(request.headers['idempotency-key']))); return
          }
          send(200, await options.whatsapp.action(store,match[1],match[2] as 'connect'|'restart'|'disconnect')); return
        }
        throw new ApiError(405, 'Método no permitido.')
      }
      if (path === '/api/conversations' || path.startsWith('/api/conversations/')) {
        if (!store.chat) throw new ApiError(503, 'Conversaciones no disponible.')
        const relay = options.relayChatMedia
        const result = await chatRoute(request, url, store.chat, limit => readBody(request, limit), options.readChatMedia, options.syncChatHistory,
          relay ? lookup => relay(token, lookup) : undefined)
        send(result.status, result.data); return
      }
      if (path.startsWith('/api/crm/')) {
        if (!store.crm) throw new ApiError(503, 'CRM no disponible.')
        const result = await crmRoute(request, url, store.crm, () => readBody(request, 524288)); send(result.status, result.data); return
      }
      if (path === '/api/campaigns' || path.startsWith('/api/campaigns/')) {
        if (!store.campaigns) throw new ApiError(503, 'Campañas no disponibles.')
        const result = await campaignRoute(request, url, store.campaigns, () => readBody(request, 524288)); send(result.status, result.data); return
      }
      if (path === '/api/workspace' && request.method === 'GET') { send(200, store.membership); return }
      if (path === '/api/imports' && request.method === 'GET') { send(200,{ imports:await store.imports.recent() }); return }
      if (path === '/api/imports/preview' && request.method === 'POST') {
        if (request.headers['content-type'] !== 'application/octet-stream') throw new ApiError(415, 'Se requiere el archivo original.')
        if (uploads >= 2) throw new ApiError(429, 'Ya se están analizando dos archivos. Esperá un momento.')
        const settings = parseOptionsSchema.parse(Object.fromEntries(url.searchParams))
        uploads++
        try { send(201, await store.imports.stage(await parseInWorker(await readBytes(request, IMPORT_LIMITS.bytes), settings))) }
        finally { uploads-- }
        return
      }
      const importMatch = /^\/api\/imports\/([^/]+)(?:\/(commit|report|check|draft))?$/.exec(path)
      if (importMatch) {
        const id = z.uuid().parse(importMatch[1])
        if (!importMatch[2] && request.method === 'GET') { send(200, await store.imports.draft(id)); return }
        if (importMatch[2] === 'report' && request.method === 'GET') { send(200, { rows: await store.imports.report(id) }); return }
        if (importMatch[2] === 'check' && request.method === 'POST') { send(200, await store.imports.check(id,await readBody(request,IMPORT_LIMITS.previewBytes))); return }
        if (importMatch[2] === 'draft' && request.method === 'POST') {
          const body = z.object({ revision:z.number().int().nonnegative(),choices:z.unknown() }).strict().parse(await readBody(request,IMPORT_LIMITS.previewBytes))
          send(200,await store.imports.save(id,body.revision,body.choices)); return
        }
        if (importMatch[2] === 'commit' && request.method === 'POST') {
          const key = z.uuid().parse(request.headers['idempotency-key'])
          send(200, await store.imports.commit(id, key, await readBody(request, IMPORT_LIMITS.previewBytes))); return
        }
      }
      const lead = /^\/api\/leads\/([^/]+)$/.exec(path)
      if (lead && request.method === 'PATCH') {
        const parsed = leadInput.safeParse(await readBody(request))
        if (!parsed.success) throw new ApiError(422, parsed.error.issues[0]?.message ?? 'Revisá los datos del contacto.')
        send(200, await store.imports.updateContact(z.uuid().parse(lead[1]), parsed.data)); return
      }
      const contacts = /^\/api\/lead-lists\/([^/]+)\/leads$/.exec(path)
      if (contacts && request.method === 'GET') {
        const id = z.uuid().parse(contacts[1])
        const page = z.coerce.number().int().min(1).max(100_000).parse(url.searchParams.get('page') ?? 1)
        const phone = z.string().max(30).regex(/^\d*$/).parse(url.searchParams.get('phone') ?? '')
        send(200, await store.imports.contacts(id, page, phone)); return
      }
      if (path === '/api/lead-lists' && request.method === 'GET') {
        const page = z.coerce.number().int().min(1).max(100_000).parse(url.searchParams.get('page') ?? 1)
        const search = z.string().trim().max(100).parse(url.searchParams.get('search') ?? '')
        send(200, await store.list(page, search)); return
      }
      if (path === '/api/lead-lists' && request.method === 'POST') {
        const id = z.uuid().safeParse(request.headers['idempotency-key'])
        if (!id.success) throw new ApiError(400, 'Falta un identificador válido para la solicitud.')
        const input = inputSchema.parse(await readBody(request))
        send(201, await store.create(input, id.data)); return
      }
      const match = /^\/api\/lead-lists\/([^/]+)$/.exec(path)
      if (match && request.method === 'PATCH') {
        const id = z.uuid().parse(match[1])
        send(200, await store.update(id, inputSchema.parse(await readBody(request)))); return
      }
      throw new ApiError(404, 'No encontramos esa operación.')
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error instanceof z.ZodError ? 422 : 503
      const message = error instanceof ApiError ? error.message : error instanceof z.ZodError ? 'Revisá los campos y parámetros de la solicitud.' : 'El servicio no está disponible. Volvé a intentar.'
      // Solo metadatos operativos: nunca tokens, cuerpos, teléfonos o errores SQL.
      if (status >= 500) console.error(JSON.stringify({ requestId, status }))
      send(status, { error: message, requestId })
    }
  })
  server.requestTimeout = 60_000
  server.headersTimeout = 10_000
  return server
}

function reply(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed || response.headersSent) return
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}
