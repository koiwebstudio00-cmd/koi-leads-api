import { writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { workerCycle } from './campaigns/worker-cycle.ts'
import { createWorkerRuntime } from './worker-runtime.ts'

const runtime = createWorkerRuntime('campaign')
const { config, machine, controller, workerId, enabled } = runtime
let failures = 0
while (!controller.signal.aborted) {
  try {
    await workerCycle({ command: machine.command, instance: config.EVOLUTION_INSTANCE_NAME, workerId, enabled, signal: controller.signal,
      connected: () => runtime.connected(config.EVOLUTION_INSTANCE_NAME),
      send: (phone, text) => runtime.send(config.EVOLUTION_INSTANCE_NAME, { phone, text, mime: null, fileName: null, base64: null }),
    })
    await writeFile('/tmp/koi-worker-heartbeat', String(Date.now()), { mode: 0o600 })
    failures = 0
  } catch {
    failures++
    console.error(JSON.stringify({ event: 'worker_cycle_failed', lane: 'campaign', workerId, consecutiveFailures: failures }))
  }
  await sleep(Math.min(30000, config.KOI_WORKER_POLL_MS * 2 ** Math.min(failures, 4)), undefined, { signal: controller.signal }).catch(() => {})
}
await machine.close()
