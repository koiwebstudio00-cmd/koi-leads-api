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
        if (response.status === 400 && await rejectedRecipient(response, number)) {
          return { outcome: 'failed', reason: 'not_on_whatsapp' }
        }
        if (response.status !== 400) await response.body?.cancel()
        if (response.status === 429) {
          const retry = response.headers.get('retry-after')
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry ?? '') - Date.now()) / 1000
          return { outcome: 'unknown', reason: 'provider_429', retryAfterSeconds: Number.isFinite(seconds) ? Math.max(1, Math.min(86400, Math.ceil(seconds))) : 60 }
        }
        // Sólo rechazos previos inequívocos. Un 5xx/429 puede ocultar aceptación previa.
        if ([401,403,404].includes(response.status)) return { outcome: 'failed', reason: `provider_${response.status}` }
        return { outcome: 'unknown', reason: `provider_${response.status}` }
      }
      const body = accepted.safeParse(await response.json())
      return body.success ? { outcome: 'accepted', providerId: body.data.key.id } : { outcome: 'unknown', reason: 'invalid_response' }
    } catch { return { outcome: 'unknown', reason: 'network_or_timeout' } }
  }
}

// Require the provider to name this recipient and explicitly deny registration.
async function rejectedRecipient(response: Response, number: string) {
  const reader = response.body?.getReader()
  if (!reader) return false
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 8192) { await reader.cancel(); return false }
      chunks.push(value)
    }
    const parsed = z.object({ response: z.object({ message: z.array(z.object({
      exists: z.literal(false), number: z.string(),
    })) }) }).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    return parsed.success && parsed.data.response.message.some(item => item.number.replace(/^\+/, '') === number)
  } catch { return false }
}
