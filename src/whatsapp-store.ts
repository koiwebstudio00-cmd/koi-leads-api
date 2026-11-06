import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from './store.ts'
export type InstanceRecord = { id: string; label: string; instance_name: string; request_id: string }
export type WhatsAppStore = {
  list(): Promise<InstanceRecord[]>
  reserve(label: string, key: string): Promise<InstanceRecord>
  get(id: string): Promise<InstanceRecord>
  assertIdle(): Promise<void>
}
export function createWhatsAppStore(client: SupabaseClient, workspace: string): WhatsAppStore {
  const fields = 'id,label,instance_name,request_id'
  function check(error: { code?: string } | null) {
    if (error?.code === '23514') throw new ApiError(422,'Este espacio admite hasta 10 conexiones adicionales. Contactá al administrador para ampliar el límite.')
    if (error) throw new ApiError(error.code === '42501' ? 403 : 503, 'No pudimos consultar las conexiones de WhatsApp.')
  }
  return {
    async list() {
      const { data, error } = await client.from('koi_whatsapp_instances').select(fields).eq('workspace_id',workspace).order('created_at'); check(error); return data ?? []
    },
    async get(id) {
      const { data, error } = await client.from('koi_whatsapp_instances').select(fields).eq('workspace_id',workspace).eq('id',id).maybeSingle(); check(error)
      if (!data) throw new ApiError(404,'No encontramos esa conexión.'); return data
    },
    async reserve(label,key) {
      const lookup = () => client.from('koi_whatsapp_instances').select(fields).eq('workspace_id',workspace).eq('request_id',key).maybeSingle()
      const existing = await lookup(); check(existing.error)
      if (existing.data) { if(existing.data.label!==label) throw new ApiError(409,'La solicitud ya se usó con otro nombre.'); return existing.data }
      const { data,error } = await client.from('koi_whatsapp_instances').insert({workspace_id:workspace,label,request_id:key}).select(fields).single()
      if(error?.code==='23505') {const raced=await lookup(); check(raced.error); if(raced.data?.label===label)return raced.data}
      check(error); return data!
    },
    async assertIdle() {
      const [campaigns,recipients] = await Promise.all([
        client.from('koi_campaigns').select('id').eq('workspace_id',workspace).in('status',['scheduled','running','paused']).limit(1),
        client.from('koi_campaign_recipients').select('id').eq('workspace_id',workspace).in('status',['leased','sending','unknown']).limit(1),
      ]); check(campaigns.error);check(recipients.error)
      if(campaigns.data?.length || recipients.data?.length) throw new ApiError(409,'Finalizá o cancelá la campaña activa y resolvé los envíos por revisar antes de desconectar o reiniciar el remitente.')
    },
  }
}
