import { Client } from 'pg'
import { machineConnectionOptions } from './campaigns/machine-store.ts'
import { createWakeup } from './worker-wakeup.ts'

export async function listenForChat(connection: string, caFile: string | undefined, onWake: () => void, signal: AbortSignal) {
  // LISTEN requires a session connection. Polling remains active if unavailable.
  let options: ReturnType<typeof machineConnectionOptions>
  let port: string
  try { options = machineConnectionOptions(connection, caFile); port = new URL(connection).port }
  catch { console.error(JSON.stringify({ event: 'chat_listener_invalid_configuration' })); return }
  if (port === '6543') {
    console.error(JSON.stringify({ event: 'chat_listener_requires_session_connection' }))
    return
  }
  while (!signal.aborted) {
    const wake = createWakeup()
    const client = new Client(options)
    let disconnected = false
    const close = () => { disconnected = true; wake.wake() }
    client.on('error', close)
    client.on('end', close)
    client.on('notification', message => { if (message.channel === 'koi_chat_ready') onWake() })
    try {
      await client.connect()
      await client.query('LISTEN koi_chat_ready')
      onWake()
      while (!signal.aborted && !disconnected) await wake.wait(30000, signal)
    } catch { console.error(JSON.stringify({ event: 'chat_listener_reconnecting' })) }
    finally { await client.end().catch(() => {}) }
    if (!signal.aborted) await createWakeup().wait(1000, signal)
  }
}
