import { z } from 'zod'
import type { SendOutcome } from './contracts.ts'

// Contrato contrastado con Evolution 2.3.7, commit cd800f2, SendTextDto.
const accepted = z.object({ key: z.object({ id: z.string().min(1).max(200) }) })
export function createTextSender(config: { url: string; apiKey: string; instance: string }, request: typeof fetch = fetch) {
  return async (number: string, text: string): Promise<SendOutcome> => {
    if (!/^[1-9][0-9]{9,14}$/.test(number) || !text.trim() || text.length > 4000) return { outcome: 'failed', reason: 'invalid_message' }
    try {
      const response = await request(`${config.url}/message/sendText/${encodeURIComponent(config.instance)}`, {
        method: 'POST', headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, text, linkPreview: false }), redirect: 'error', signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        // Sólo rechazos previos inequívocos. Un 5xx/429 puede ocultar aceptación previa.
        if ([401,403,404].includes(response.status)) return { outcome: 'failed', reason: `provider_${response.status}` }
        return { outcome: 'unknown', reason: `provider_${response.status}` }
      }
      const body = accepted.safeParse(await response.json())
      return body.success ? { outcome: 'accepted', providerId: body.data.key.id } : { outcome: 'unknown', reason: 'invalid_response' }
    } catch { return { outcome: 'unknown', reason: 'network_or_timeout' } }
  }
}
