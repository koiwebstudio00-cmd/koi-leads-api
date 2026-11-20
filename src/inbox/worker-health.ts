import { readFileSync } from 'node:fs'

const loops = ['ingest']
const rich = process.env.KOI_INBOX_RICH_ENABLED === 'true'
const sending = process.env.KOI_INBOX_SEND_ENABLED === 'true'

if (rich) loops.push('media')
if (sending) loops.push('send-1', 'send-2')
if (rich && sending) loops.push('reactions')

const now = Date.now()
const maxAgeMs = 4 * 60 * 1000
try {
  for (const loop of loops) {
    const lastHeartbeat = Number(readFileSync(`/tmp/koi-inbox-${loop}-heartbeat`, 'utf8'))
    const ageMs = now - lastHeartbeat
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= maxAgeMs) process.exit(1)
  }
} catch {
  process.exit(1)
}
