import type { ChatSendJob } from './conversations.ts'
import type { SendOutcome } from './campaigns/contracts.ts'
import type { MachineCommand } from './campaigns/machine-store.ts'

export async function chatWorkerCycle(options: {
  command: MachineCommand; instance: string; account: string; signal: AbortSignal;
  connected: () => Promise<boolean>; send: (job: ChatSendJob) => Promise<SendOutcome>
}): Promise<boolean> {
  const { command, instance, account, signal } = options
  if (signal.aborted) return false
  const reservation = await command<{ id: string; token: string; instance: string } | null>('chat_claim', { instance, account })
  if (!reservation) return false
  const data = { instance, id: reservation.id, token: reservation.token }
  if (signal.aborted || !await options.connected()) {
    await command('chat_defer', data)
    return false
  }
  const ready = await command<ChatSendJob | null>('chat_begin', data)
  if (!ready) return true
  const started = performance.now()
  const outcome: SendOutcome = signal.aborted ? { outcome: 'failed', reason: 'stopped_before_send' } : await options.send(ready)
  await command('chat_finish', { ...data, ...outcome })
  console.log(JSON.stringify({ event: 'chat_dispatch_finished', jobId: data.id, outcome: outcome.outcome, queueWaitMs: ready.queueWaitMs === undefined ? undefined : Math.round(ready.queueWaitMs), providerMs: Math.round(performance.now() - started) }))
  return true
}
