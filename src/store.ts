import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createImportStore, type ImportStore } from './import-store.ts'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export type Membership = { workspace_id: string; role: 'admin' | 'operator'; workspace_name: string }
export type LeadList = { id: string; name: string; description: string; created_at: string; updated_at: string }
export type ListInput = { name: string; description: string }
export type ListPage = { lists: LeadList[]; total: number }
export type UserStore = {
  imports: ImportStore
  userId: string
  membership: Membership
  list: (page: number, search: string) => Promise<ListPage>
  create: (input: ListInput, requestId: string) => Promise<LeadList>
  update: (id: string, input: ListInput) => Promise<LeadList>
}
export type Authorize = (token: string) => Promise<UserStore>

const listSchema = z.object({ id: z.uuid(), name: z.string(), description: z.string(), created_at: z.string(), updated_at: z.string() })
const selection = 'id,name,description,created_at,updated_at'

function databaseError(error: { code?: string } | null): void {
  if (!error) return
  if (error.code === '23505') throw new ApiError(409, 'Ya existe una base con ese nombre.')
  if (error.code === 'PT409') throw new ApiError(409, 'Esta importación cambió o ya se confirmó con otra selección. Consultá el resultado o recargá la preparación.')
  if (error.code === '22023' || error.code === '23514') throw new ApiError(422, 'La importación contiene datos no válidos. Revisá la selección y el mapeo.')
  if (error.code === '42501') throw new ApiError(403, 'No tenés permiso para esta operación.')
  throw new ApiError(503, 'No pudimos consultar las bases. Volvé a intentar.')
}

export function createAuthorizer(url: string, publishableKey: string): Authorize {
  return async token => {
    // Un cliente por petición; ningún JWT se comparte entre usuarios.
    const client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
      },
    })
    const { data: auth, error: authError } = await client.auth.getUser(token)
    if (authError && (!authError.status || authError.status >= 500)) throw new ApiError(503, 'No pudimos verificar tu sesión. Volvé a intentar.')
    if (authError || !auth.user || auth.user.is_anonymous) throw new ApiError(401, 'Tu sesión venció. Volvé a ingresar.')
    const { data, error } = await client.from('koi_workspace_members')
      .select('workspace_id,role,koi_workspaces(name)').eq('user_id', auth.user.id).limit(2)
    databaseError(error)
    if (!data || data.length !== 1) throw new ApiError(403, 'Tu cuenta todavía no tiene acceso al equipo Koi.')
    const record = z.object({ workspace_id: z.uuid(), role: z.enum(['admin', 'operator']), koi_workspaces: z.object({ name: z.string() }) }).parse(data[0])
    const membership: Membership = { workspace_id: record.workspace_id, role: record.role, workspace_name: record.koi_workspaces.name }
    return {
      imports: createImportStore(client, membership.workspace_id, auth.user.id, databaseError),
      userId: auth.user.id,
      membership,
      async list(page, search) {
        let query = client.from('koi_lead_lists').select(selection, { count: 'exact' })
          .eq('workspace_id', membership.workspace_id)
        if (search) query = query.ilike('name', `%${search.replace(/[\\%_]/g, '\\$&')}%`)
        const { data, error, count } = await query.order('created_at', { ascending: false })
          .order('id', { ascending: false }).range((page - 1) * 24, page * 24 - 1)
        databaseError(error)
        return { lists: z.array(listSchema).parse(data), total: count ?? 0 }
      },
      async create(input, requestId) {
        const { data: existing, error: lookupError } = await client.from('koi_lead_lists').select(selection)
          .eq('workspace_id', membership.workspace_id).eq('request_id', requestId).maybeSingle()
        databaseError(lookupError)
        if (existing) {
          if (existing.name !== input.name || existing.description !== input.description) throw new ApiError(409, 'La solicitud ya se usó con otros datos.')
          return listSchema.parse(existing)
        }
        const { data, error } = await client.from('koi_lead_lists').insert({ ...input, workspace_id: membership.workspace_id, created_by: auth.user.id, request_id: requestId }).select(selection).single()
        if (error?.code === '23505') {
          // Dos solicitudes concurrentes pueden haber creado la misma base.
          const { data: raced, error: racedError } = await client.from('koi_lead_lists').select(selection)
            .eq('workspace_id', membership.workspace_id).eq('request_id', requestId).maybeSingle()
          databaseError(racedError)
          if (raced && raced.name === input.name && raced.description === input.description) return listSchema.parse(raced)
        }
        databaseError(error)
        return listSchema.parse(data)
      },
      async update(id, input) {
        const { data, error } = await client.from('koi_lead_lists').update(input)
          .eq('id', id).eq('workspace_id', membership.workspace_id).select(selection).maybeSingle()
        databaseError(error)
        if (!data) throw new ApiError(404, 'No encontramos esa base.')
        return listSchema.parse(data)
      },
    }
  }
}
