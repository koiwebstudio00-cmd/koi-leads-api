import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { createInboxMachine } from './machine.ts'
import { createZernioClient } from './provider.ts'
import { createInboxIngestCycle } from './ingest-cycle.ts'
import { createInboxSendCycle } from './send-cycle.ts'
import { createInboxTextSender } from './send-provider.ts'

const result=z.object({KOI_INBOX_INGEST_DATABASE_URL:z.string().min(1),ZERNIO_API_KEY:z.string().min(16),
 KOI_ZERNIO_WORKSPACE_ID:z.uuid(),ZERNIO_PROFILE_ID:z.string().min(1).max(200),KOI_DATABASE_CA_FILE:z.string().optional(),KOI_INBOX_SEND_ENABLED:z.enum(['true','false']).default('false')}).safeParse(process.env)
if(!result.success)throw new Error('Configuración Inbox inválida: '+result.error.issues.map(i=>i.path.join('.')).join(', '))
const config=result.data
const machine=createInboxMachine(config.KOI_INBOX_INGEST_DATABASE_URL,config.KOI_DATABASE_CA_FILE)
const stop=new AbortController()
const cycle=createInboxIngestCycle(machine.command,createZernioClient(config.ZERNIO_API_KEY),{workspaceId:config.KOI_ZERNIO_WORKSPACE_ID,profileId:config.ZERNIO_PROFILE_ID},stop.signal)
const sendCycle=createInboxSendCycle(machine.dispatch,createZernioClient(config.ZERNIO_API_KEY),createInboxTextSender(config.ZERNIO_API_KEY),{profileId:config.ZERNIO_PROFILE_ID,workspaceId:config.KOI_ZERNIO_WORKSPACE_ID},stop.signal)
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop.abort())
try{
 await writeFile('/tmp/koi-inbox-ingest-heartbeat',String(Date.now()))
 async function loop(run:()=>Promise<boolean>,name:string){
  while(!stop.signal.aborted){
   let wait=500
   try{if(await run())wait=25;await writeFile('/tmp/koi-inbox-'+name+'-heartbeat',String(Date.now()))}catch{console.error(JSON.stringify({event:'inbox_'+name+'_cycle_failed'}));wait=5000}
   await delay(wait,undefined,{signal:stop.signal}).catch(()=>{})
  }
 }
 await Promise.all([loop(cycle,'ingest'),...(config.KOI_INBOX_SEND_ENABLED==='true'?[loop(sendCycle,'send-1'),loop(sendCycle,'send-2')]:[])])
}finally{await machine.close()}
