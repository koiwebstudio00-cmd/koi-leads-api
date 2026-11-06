import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../store.ts'
import type { CampaignCommand } from './contracts.ts'

export function createCampaignStore(client: SupabaseClient): CampaignCommand {
  return async (action, data) => {
    const result = await client.rpc('koi_campaign_command', { p_action: action, p_data: data })
    if (result.error) {
      const code = result.error.code
      if (code === '42501') throw new ApiError(403, 'No tenés permiso para esta campaña.')
      if (code === 'PT404') throw new ApiError(404, 'No encontramos la campaña.')
      if (code === 'PT409' || code === '23505') throw new ApiError(409, 'La campaña cambió o ya hay una activa. Actualizá la vista antes de continuar.')
      if (code === '22023' || code === '23514' || code === '23502' || code === '22P02') throw new ApiError(422, 'Revisá el mensaje, la selección y los horarios. Debe haber contactos habilitados para enviar.')
      if (code === 'PT503') throw new ApiError(503, 'Falta configurar el remitente de campañas.')
      throw new ApiError(503, 'No pudimos consultar las campañas. Volvé a intentar.')
    }
    return result.data
  }
}
