import type { QueueJob, SendOutcome } from './contracts.ts'
import type { MachineCommand } from './machine-store.ts'

export async function workerCycle(options: {
  command: MachineCommand; instance: string; workerId: string; enabled: boolean; signal: AbortSignal;
  connected: () => Promise<boolean>; send: (phone: string, text: string) => Promise<SendOutcome>
}) {
  const { command, signal, instance, workerId, enabled } = options
  const call = <T>(action: string, data: Record<string, unknown> = {}) => command<T>(action, { instance, ...data })
  await call('tick', { workerId, enabled })
  if (!enabled || signal.aborted) return
  const job = await call<QueueJob | null>('claim')
  if (!job) return
  const reservation = { id: job.id, token: job.lease_token }
  if (signal.aborted || !await options.connected()) { await call('defer', reservation); return }
  const ready = await call<QueueJob | null>('begin', reservation)
  if (!ready) return
  const outcome = signal.aborted ? { outcome: 'failed' as const, reason: 'stopped_before_send' } : await options.send(ready.phone, ready.message)
  // A failure to persist never repeats the provider POST; the lease recovers as unknown.
  await call('finish', { ...reservation, ...outcome })
}
