import { z } from 'zod'
import type { EvolutionIssue, EvolutionStatus } from './contracts/evolution.ts'

export type EvolutionConnection = { workspaceId: string; status: () => Promise<EvolutionStatus> }
const responseSchema = z.object({ instance: z.object({ instanceName: z.string(), state: z.enum(['open', 'connecting', 'close']) }) })

// Una instancia fija por instalación. Nunca aceptar URL, instancia o clave del navegador.
export function createEvolutionConnection(config: { url: string; apiKey: string; instanceName: string; workspaceId: string }, dependencies: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): EvolutionConnection {
  const request = dependencies.fetch ?? fetch
  const now = dependencies.now ?? Date.now
  let cached: EvolutionStatus | undefined
  let expiresAt = 0
  let pending: Promise<EvolutionStatus> | undefined

  async function query(): Promise<EvolutionStatus> {
    const result = (state: EvolutionStatus['state'], issue?: EvolutionIssue): EvolutionStatus => ({
      state, instanceName: config.instanceName, checkedAt: new Date(now()).toISOString(), ...(issue ? { issue } : {}),
    })
    try {
      const response = await request(`${config.url}/instance/connectionState/${encodeURIComponent(config.instanceName)}`, {
        method: 'GET', headers: { apikey: config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(dependencies.timeoutMs ?? 8000), redirect: 'error',
      })
      if (!response.ok) {
        // No leer ni devolver cuerpos de error del proveedor: pueden contener secretos.
        await response.body?.cancel()
        return result('unavailable', response.status === 401 || response.status === 403 ? 'credentials' : response.status === 404 ? 'instance_missing' : 'provider')
      }
      const parsed = responseSchema.safeParse(await response.json())
      if (!parsed.success || parsed.data.instance.instanceName !== config.instanceName) return result('unavailable', 'invalid_response')
      const states = { open: 'connected', connecting: 'connecting', close: 'disconnected' } as const
      return result(states[parsed.data.instance.state])
    } catch {
      return result('unavailable', 'network')
    }
  }

  return {
    workspaceId: config.workspaceId,
    async status() {
      // Compartir solo el resultado público de esta conexión; jamás tokens de usuarios.
      if (cached && now() < expiresAt) return cached
      if (!pending) pending = query().then(value => { cached = value; expiresAt = now() + 5000; return value }).finally(() => { pending = undefined })
      return pending
    },
  }
}
