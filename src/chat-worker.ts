import { writeFile } from 'node:fs/promises'
import { createWorkerRuntime } from './worker-runtime.ts'
import { chatWorkerCycle } from './chat-worker-cycle.ts'
import { createWakeup } from './worker-wakeup.ts'
import { listenForChat } from './chat-worker-listener.ts'

const runtime = createWorkerRuntime('chat')
const { config, machine, controller, workerId, enabled } = runtime
const mainWake = createWakeup()
const loops = new Map<string, { wake: ReturnType<typeof createWakeup>; done: Promise<void> }>()
const listener = listenForChat(config.KOI_CHAT_LISTEN_DATABASE_URL || runtime.connectionString, config.KOI_DATABASE_CA_FILE,
  () => { mainWake.wake(); for (const item of loops.values()) item.wake.wake() }, controller.signal)
async function drain(account: string, wake: ReturnType<typeof createWakeup>) {
  let failures = 0
  while (!controller.signal.aborted) {
    try {
      if (enabled && await chatWorkerCycle({ command: machine.command, instance: config.EVOLUTION_INSTANCE_NAME, account,
        signal: controller.signal, connected: () => runtime.connected(account), send: job => runtime.send(account, job) })) {
        failures = 0
        continue
      }
      failures = 0
    } catch {
      failures++
      console.error(JSON.stringify({ event: 'worker_cycle_failed', lane: 'chat', workerId, consecutiveFailures: failures }))
    }
    await wake.wait(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), controller.signal)
  }
}
// The registry bounds the number of accounts; each account drains independently and serially.
while (!controller.signal.aborted) {
  try {
    await machine.command('chat_tick', { instance: config.EVOLUTION_INSTANCE_NAME, workerId, enabled })
    const accounts = await machine.command<{ instance: string }[]>('chat_accounts', { instance: config.EVOLUTION_INSTANCE_NAME })
    for (const { instance } of accounts) if (!loops.has(instance)) {
      const wake = createWakeup()
      loops.set(instance, { wake, done: drain(instance, wake) })
    }
    await writeFile('/tmp/koi-chat-worker-heartbeat', String(Date.now()), { mode: 0o600 })
  } catch { console.error(JSON.stringify({ event: 'chat_worker_heartbeat_failed', workerId })) }
  await mainWake.wait(1000, controller.signal)
}
await listener
await Promise.all([...loops.values()].map(item => item.done))
await machine.command('chat_tick', { instance: config.EVOLUTION_INSTANCE_NAME, workerId, enabled: false }).catch(() => {})
await machine.close()
