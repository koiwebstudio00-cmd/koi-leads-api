import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { createInboxMachine } from './machine.ts'
import { createZernioClient } from './provider.ts'
import { createInboxIngestCycle } from './ingest-cycle.ts'

const result=z.object({KOI_INBOX_INGEST_DATABASE_URL:z.string().min(1),ZERNIO_API_KEY:z.string().min(16),
 KOI_ZERNIO_WORKSPACE_ID:z.uuid(),ZERNIO_PROFILE_ID:z.string().min(1).max(200),KOI_DATABASE_CA_FILE:z.string().optional()}).safeParse(process.env)
if(!result.success)throw new Error('Configuración Inbox inválida: '+result.error.issues.map(i=>i.path.join('.')).join(', '))
const config=result.data
const machine=createInboxMachine(config.KOI_INBOX_INGEST_DATABASE_URL,config.KOI_DATABASE_CA_FILE)
const stop=new AbortController()
const cycle=createInboxIngestCycle(machine.command,createZernioClient(config.ZERNIO_API_KEY),{workspaceId:config.KOI_ZERNIO_WORKSPACE_ID,profileId:config.ZERNIO_PROFILE_ID},stop.signal)
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop.abort())
try{
 await writeFile('/tmp/koi-inbox-ingest-heartbeat',String(Date.now()))
 while(!stop.signal.aborted){
   let wait=1000
   try{if(await cycle())wait=100;await writeFile('/tmp/koi-inbox-ingest-heartbeat',String(Date.now()))}catch{console.error(JSON.stringify({event:'inbox_cycle_failed'}));wait=5000}
   await delay(wait,undefined,{signal:stop.signal}).catch(()=>{})
 }
}finally{await machine.close()}
