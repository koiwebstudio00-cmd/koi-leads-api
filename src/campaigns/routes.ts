import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { campaignInput, type CampaignCommand } from './contracts.ts'
import { ApiError } from '../store.ts'

export async function campaignRoute(request: IncomingMessage, url: URL, command: CampaignCommand, readBody: () => Promise<unknown>) {
  const path = url.pathname
  const key = () => z.uuid().parse(request.headers['idempotency-key'])
  const page = () => z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('page') ?? 1)
  if (path === '/api/campaigns') {
    if (request.method === 'GET') return { status: 200, data: await command('list', { page: page() }) }
    if (request.method === 'POST') return { status: 201, data: await command('create', { ...campaignInput.parse(await readBody()), key: key() }) }
  }
  const match = /^\/api\/campaigns\/([^/]+)(?:\/(preview|start|pause|resume|cancel|recipients|progress|events|resolve))?$/.exec(path)
  if (!match) throw new ApiError(404, 'No encontramos esa operación.')
  const id = z.uuid().parse(match[1]); const action = match[2]
  if (request.method === 'GET') {
    if (!action || action === 'progress') return { status: 200, data: await command('detail', { id }) }
    if (action === 'recipients') return { status: 200, data: await command('recipients', { id, page: page(), status: z.enum(['','queued','leased','sending','accepted','unknown','failed','skipped','cancelled']).parse(url.searchParams.get('status') ?? '') }) }
    if (action === 'events') return { status: 200, data: await command('events', { id, after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? 0) }) }
  }
  if (request.method === 'PATCH' && !action) {
    const input = z.object({ revision: z.number().int().nonnegative(), input: campaignInput }).strict().parse(await readBody())
    return { status: 200, data: await command('update', { id, revision: input.revision, ...input.input }) }
  }
  if (request.method === 'POST' && action) {
    if (action === 'start') {
      const input = z.object({ revision: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{32}$/) }).strict().parse(await readBody())
      return { status: 202, data: await command('start', { id, key: key(), revision: input.revision, fingerprint: input.fingerprint }) }
    }
    if (['preview','pause','resume','cancel'].includes(action)) return { status: 200, data: await command(action, { id }) }
    if (action === 'resolve') {
      const input = z.object({ recipientId: z.uuid(), decision: z.literal('do_not_resend') }).strict().parse(await readBody())
      return { status: 200, data: await command('resolve', { id, ...input }) }
    }
  }
  throw new ApiError(404, 'No encontramos esa operación.')
}
