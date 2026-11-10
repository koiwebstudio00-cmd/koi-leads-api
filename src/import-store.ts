import type { LeadInput } from './lead-input.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { ImportUpdate, ImportCheck, ImportDraft, ImportResult, Lead, ParsedImport, RecentImport } from './contracts/imports.ts'
import { ApiError } from './store.ts'
import { prepareCommit, validateDraftChoices } from './import-service.ts'

export type ImportStore = {
  updateContact: (id: string, input: LeadInput) => Promise<{ id: string; revision: number }>
  recent: () => Promise<RecentImport[]>
  stage: (data: ParsedImport) => Promise<ImportDraft>
  draft: (id: string) => Promise<ImportDraft>
  commit: (id: string, key: string, input: unknown) => Promise<ImportResult>
  check: (id: string, input: unknown) => Promise<ImportCheck>
  save: (id: string, revision: number, input: unknown) => Promise<{ revision:number }>
  contacts: (listId: string, page: number, phone: string) => Promise<{ leads: Lead[]; total: number }>
  report: (id: string) => Promise<unknown[]>
}
type DbError = (error: { code?: string } | null) => void
const importRecord = z.object({ id: z.uuid(), status: z.enum(['draft','committed']), payload: z.unknown(), result: z.unknown().nullable(),choices:z.unknown().nullable(),revision:z.number().int() })
function decode(record: unknown): ImportDraft {
  const row = importRecord.parse(record)
  return { ...row.payload as ParsedImport, id: row.id, status: row.status, result: row.result as ImportResult | null,choices:row.choices as ImportDraft['choices'],revision:row.revision }
}

export function createImportStore(client: SupabaseClient, workspace: string, userId: string, databaseError: DbError): ImportStore {
  const store: ImportStore = {
    async updateContact(id, { revision, ...input }) {
      const { data, error } = await client.from('koi_leads').update(input)
        .eq('id', id).eq('workspace_id', workspace).is('deleted_at',null).eq('revision', revision).select('id,revision').maybeSingle()
      if (error?.code === '23505') throw new ApiError(409, 'Ese teléfono ya pertenece a otro contacto de este espacio.')
      databaseError(error)
      if (!data) throw new ApiError(409, 'El contacto cambió o ya no está disponible. Cerrá la edición, actualizá la base y volvé a intentar.')
      return z.object({ id: z.uuid(), revision: z.number().int() }).parse(data)
    },
    async recent() {
      const { data,error } = await client.from('koi_imports').select('id,filename,status,created_at').eq('workspace_id',workspace).eq('created_by',userId).order('created_at',{ ascending:false }).limit(10)
      databaseError(error)
      return z.array(z.object({ id:z.uuid(),filename:z.string(),status:z.enum(['draft','committed']),created_at:z.string() })).parse(data)
    },
    async stage(payload) {
      const { data, error } = await client.from('koi_imports').insert({ workspace_id: workspace, created_by: userId, payload }).select('id,status,payload,result,choices,revision').single()
      databaseError(error); return decode(data)
    },
    async draft(id) {
      const { data, error } = await client.from('koi_imports').select('id,status,payload,result,choices,revision').eq('workspace_id', workspace).eq('created_by', userId).eq('id', id).maybeSingle()
      databaseError(error)
      if (!data) throw new ApiError(404, 'No encontramos esa importación en tu cuenta.')
      return decode(data)
    },
    async commit(id, key, input) {
      const prepared = prepareCommit(await store.draft(id), input)
      const { data, error } = await client.rpc('koi_commit_import', { p_import_id: id, p_key: key, p_payload: prepared })
      databaseError(error)
      return data as ImportResult
    },
    async check(id,input) {
      const prepared = prepareCommit(await store.draft(id),input)
      const phones = [...new Set(prepared.rows.filter(row => row.selected).map(row => row.phone))]
      const { data,error } = await client.rpc('koi_check_import_phones',{ p_phones:phones })
      databaseError(error)
      const preview=await client.rpc('koi_import_update_preview',{p_rows:prepared.rows,p_fields:prepared.choices.updateFields??[],p_product:prepared.choices.product??null});databaseError(preview.error)
      return {...z.object({newContacts:z.number().int(),existingContacts:z.number().int(),blocked:z.number().int()}).parse(data),updates:(preview.data??[]) as ImportUpdate[]}
    },
    async save(id,revision,input) {
      const choices = validateDraftChoices(await store.draft(id),input)
      const { data,error } = await client.rpc('koi_save_import_draft',{ p_import_id:id,p_revision:revision,p_choices:choices })
      if (error?.code === 'PT409') throw new ApiError(409,'La preparación cambió en otra pestaña o ya se confirmó. Recargá antes de seguir.')
      databaseError(error); return { revision:z.number().int().parse(data) }
    },
    async contacts(listId, page, phone) {
      const { data: list, error: listError } = await client.from('koi_lead_lists').select('id').eq('workspace_id', workspace).eq('id', listId).maybeSingle()
      databaseError(listError)
      if (!list) throw new ApiError(404, 'No encontramos esa base.')
      let query = client.from('koi_lead_list_members').select('lead:koi_leads!inner(id,phone,name,company,email,source,consent,revision,product,extra)', { count: 'exact' }).eq('workspace_id', workspace).eq('list_id', listId).is('lead.deleted_at',null)
      if (phone) query = query.ilike('lead.phone', `%${phone}%`)
      const { data, error, count } = await query.order('created_at', { ascending: false }).order('lead_id').range((page - 1) * 50, page * 50 - 1)
      databaseError(error)
      const schema = z.array(z.object({ lead: z.object({ revision: z.number().int(), id: z.uuid(), phone: z.string(), name: z.string(), company: z.string(), email: z.string(), source: z.string(), product: z.string(), extra: z.record(z.string(), z.string()), consent: z.enum(['unknown','granted','denied']) }) }))
      const leads = schema.parse(data).map(row => row.lead)
      if (!leads.length) return { leads: [], total: count ?? 0 }
      const { data: suppressed, error: suppressionError } = await client.from('koi_suppressions').select('phone').eq('workspace_id', workspace).in('phone', leads.map(lead => lead.phone))
      databaseError(suppressionError)
      const blocked = new Set(suppressed?.map(row => row.phone as string))
      return { leads: leads.map(lead => ({ ...lead, suppressed: blocked.has(lead.phone) })), total: count ?? 0 }
    },
    async report(id) {
      await store.draft(id)
      const rows: unknown[] = []
      for (let start = 0; start < 5000; start += 500) {
        const { data, error } = await client.from('koi_import_rows').select('source_row,selected,outcome,prepared').eq('workspace_id', workspace).eq('import_id', id).order('source_row').range(start, start + 499)
        databaseError(error); rows.push(...data ?? [])
        if (!data || data.length < 500) break
      }
      return rows
    },
  }
  return store
}
