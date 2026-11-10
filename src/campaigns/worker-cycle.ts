import type { ChatSendJob } from '../conversations.ts'
import type { QueueJob, SendOutcome } from './contracts.ts'
import type { MachineCommand } from './machine-store.ts'

export async function workerCycle(options: {
  command: MachineCommand; instance: string; workerId: string; enabled: boolean; signal: AbortSignal;
  connected: () => Promise<boolean>; send: (phone: string, text: string) => Promise<SendOutcome>
  chat?: { connected: (instance: string) => Promise<boolean>; send: (instance: string, job: ChatSendJob) => Promise<SendOutcome> }
}) {
  const { command, signal, instance, workerId, enabled } = options
  const call = <T>(action: string, data: Record<string, unknown> = {}) => command<T>(action, { instance, ...data })
  await call('tick', { workerId, enabled })
  if (options.chat) await call('chat_tick')
  if (!enabled || signal.aborted) return
  if (options.chat) {
    const chat = await call<{ id: string; token: string; instance: string } | null>('chat_claim')
    if (chat) {
      const reservation = { id: chat.id, token: chat.token }
      if (signal.aborted || !await options.chat.connected(chat.instance)) await call('chat_defer', reservation)
      else {
        const ready = await call<ChatSendJob | null>('chat_begin', reservation)
        if (ready) {
          const outcome = signal.aborted ? { outcome: 'failed', reason: 'stopped_before_send' } : await options.chat.send(chat.instance, ready)
          await call('chat_finish', { ...reservation, ...outcome })
          return
        }
      }
    }
  }
  if (signal.aborted) return
  const job = await call<QueueJob | null>('claim')
  if (!job) return
  const reservation = { id: job.id, token: job.lease_token }
  if (signal.aborted || !await options.connected()) { await call('defer', reservation); return }
  const ready = await call<QueueJob | null>('begin', reservation)
  if (!ready) return
  // El POST sólo puede ejecutarse una vez en este ciclo. Reintentar persistencia no repite envío.
  const outcome = signal.aborted ? { outcome: 'failed' as const, reason: 'stopped_before_send' } : await options.send(ready.phone, ready.message)
  await call('finish', { ...reservation, ...outcome })
}
