import { createHash, ECDH } from 'node:crypto'
import { Pool } from 'pg'
import webpush from 'web-push'
import { z } from 'zod'
import { machineConnectionOptions } from './campaigns/machine-store.ts'
import { ApiError, type UserStore } from './store.ts'

// Only contact browser-operated push services. Never forward VAPID requests to arbitrary URLs.
export function isPushEndpoint(value: string) {
  try {
    const url = new URL(value)
    const host = url.hostname
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
      url.pathname.length > 1 && (host === 'fcm.googleapis.com' || host === 'web.push.apple.com' ||
        host.endsWith('.push.apple.com') || host === 'updates.push.services.mozilla.com' ||
        host.endsWith('.notify.windows.com'))
  } catch { return false }
}
const endpoint = z.string().max(2048).refine(isPushEndpoint)
const device = z.object({endpoint})
const subscription = device.extend({
  keys: z.object({
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/).refine(value => {
      try { ECDH.convertKey(Buffer.from(value,'base64url'),'prime256v1'); return true } catch { return false }
    }),
  }),
})

type Job = {id:string;lease:string;recipient:string;endpoint:string;p256dh:string;auth_key:string;title:string;body:string;path:string;event_key:string;ttl:number}
type Action = 'save'|'remove'|'status'
export type PushService = {
  publicKey:string
  device:(action:Action,store:UserStore,data:unknown)=>Promise<boolean>
}

export function createPushService(env:NodeJS.ProcessEnv) {
  const {KOI_PUSH_DATABASE_URL:connection,KOI_PUSH_PUBLIC_KEY:publicKey,KOI_PUSH_PRIVATE_KEY:privateKey,KOI_PUSH_SUBJECT:subject} = env
  if (![connection, publicKey, privateKey, subject].some(Boolean)) return undefined
  if (!connection || !publicKey || !privateKey || !subject) throw Error('Configuración Web Push incompleta.')
  webpush.setVapidDetails(subject,publicKey,privateKey)
  const pool = new Pool(machineConnectionOptions(connection,env.KOI_DATABASE_CA_FILE))
  pool.on('error',()=>console.error('push_database_error'))
  let stopping=false
  let nextSchedule=0
  let timer:ReturnType<typeof setTimeout>
  let running:Promise<void> = Promise.resolve()

  async function deliver(job:Job) {
    let outcome='sent'
    try {
      if (!isPushEndpoint(job.endpoint)) outcome='expired'
      else {
        const tag=createHash('sha256').update(job.event_key).digest('base64url').slice(0,32)
        const payload=JSON.stringify({recipient:job.recipient,title:job.title,body:job.body,path:job.path,tag})
        await webpush.sendNotification({endpoint:job.endpoint,keys:{auth:job.auth_key,p256dh:job.p256dh}},payload,
          {TTL:job.ttl,topic:tag,urgency:'high',timeout:10000})
      }
    } catch(error) {
      const status=(error as {statusCode?:number}).statusCode
      outcome=status===404||status===410?'expired':'retry'
      console.error('push_delivery_failed',status??'transport')
    }
    await pool.query('select koi_private.push_finish($1,$2,$3)',[job.id,job.lease,outcome])
  }
  async function cycle() {
    let delay=2000
    try {
      if (Date.now()>=nextSchedule) {
        await pool.query('select koi_private.push_schedule()')
        nextSchedule=Date.now()+60000
      }
      const {rows}=await pool.query<Job>('select * from koi_private.push_claim()')
      const results=await Promise.allSettled(rows.map(deliver))
      if (results.some(r=>r.status==='rejected')) console.error('push_ack_failed')
      if (rows.length===12) delay=0
    } catch { console.error('push_poll_failed'); delay=10000 }
    if (!stopping) timer=setTimeout(()=>{ running=cycle() },delay)
  }
  running=cycle()
  return { publicKey,
    async device(action:Action,store:UserStore,data:unknown) {
      const body=(action==='save'?subscription:device).parse(data)
      const result=await pool.query<{ok:boolean}>('select koi_private.push_device($1,$2,$3,$4) ok',
        [action,store.membership.workspace_id,store.userId,JSON.stringify(body)])
      if (action==='save'&&!result.rows[0]?.ok) throw new ApiError(409,'Esta suscripción ya pertenece a otra cuenta.')
      return result.rows[0]?.ok===true
    },
    async close(){stopping=true;clearTimeout(timer);await running;await pool.end()},
  }
}
