export type EvolutionState = 'not_configured' | 'connected' | 'connecting' | 'disconnected' | 'unavailable'
export type EvolutionIssue = 'credentials' | 'instance_missing' | 'provider' | 'invalid_response' | 'network'
export type EvolutionStatus = {
  state: EvolutionState
  instanceName: string | null
  checkedAt: string | null
  issue?: EvolutionIssue
}
