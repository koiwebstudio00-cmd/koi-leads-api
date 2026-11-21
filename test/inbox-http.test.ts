import { test } from 'node:test'
import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
import { createZernioClient } from '../src/inbox/provider.ts'
import { createApp } from '../src/app.ts'
import { createInboxWebhook } from '../src/inbox/webhook.ts'
import { readConfig } from '../src/config.ts'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'
import { ApiError,type UserStore } from '../src/store.ts'

test('HTTP webhook preserves raw bytes, persists before ACK, rejects forged/oversized bodies and remains separate from user auth',async()=>{
 let stored=0,fail=false,authCalls=0
 const command:MachineCommand=async<T>()=>{if(fail)throw new Error('db unavailable');stored++;return {} as T}
 const secret='synthetic-zernio-secret-1234567890'
 const server=createApp({origin:'http://localhost:5173',inboxWebhook:createInboxWebhook(secret,command),authorize:async()=>{authCalls++;throw new ApiError(401,'No session')}})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const address=server.address();assert.ok(address&&typeof address==='object')
 const url=`http://127.0.0.1:${address.port}/api/webhooks/zernio`
 const body=' { "id":"event-http", "event":"webhook.test", "timestamp":"2026-11-20T00:00:00Z" }\n'
 const signature=createHmac('sha256',secret).update(body).digest('hex')
 try{
  assert.equal((await fetch(url,{method:'POST',body,headers:{'X-Zernio-Signature':'bad'}})).status,401)
  assert.equal(stored,0)
  const result=await fetch(url,{method:'POST',body,headers:{'X-Zernio-Signature':signature}})
  assert.equal(result.status,200);assert.equal(stored,1);assert.equal(authCalls,0)
  fail=true
  assert.equal((await fetch(url,{method:'POST',body,headers:{'X-Zernio-Signature':signature}})).status,503)
  assert.equal((await fetch(url,{method:'POST',body:'x'.repeat(1048577),headers:{'X-Zernio-Signature':signature}})).status,413)
 }finally{server.closeAllConnections();server.close();await once(server,'close')}
})

test('connection status requires a user session even before the optional integration is enabled',async()=>{
 const store={userId:'test',membership:{workspace_id:'test',role:'admin'}} as UserStore
 const server=createApp({origin:'http://localhost:5173',authorize:async()=>store})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const address=server.address();assert.ok(address&&typeof address==='object')
 const url=`http://127.0.0.1:${address.port}/api/inbox/connections`
 try{
  assert.equal((await fetch(url)).status,401)
  assert.deepEqual(await(await fetch(url,{headers:{Authorization:'Bearer synthetic'}})).json(),{configured:false,accounts:[],failedEvents:0})
 }finally{server.closeAllConnections();server.close();await once(server,'close')}
})

test('Inbox configuration is opt-in and all-or-none without leaking credentials in errors',()=>{
 const base={KOI_APP_ORIGIN:'http://localhost:5173',KOI_SUPABASE_URL:'https://avqhjbrcbgqhelfkcist.supabase.co',KOI_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_test_only'}
 assert.equal(readConfig(base).ZERNIO_API_KEY,undefined)
 const secret='never-print-this-api-key'
 assert.throws(()=>readConfig({...base,ZERNIO_API_KEY:secret}),(error:unknown)=>error instanceof Error&&!error.message.includes(secret)&&error.message.includes('ZERNIO_PROFILE_ID'))
 assert.equal(readConfig({...base,ZERNIO_API_KEY:secret,ZERNIO_PROFILE_ID:'profile',KOI_ZERNIO_WORKSPACE_ID:'11111111-1111-4111-8111-111111111111',ZERNIO_WEBHOOK_SECRET:'secret'.repeat(10),KOI_INBOX_GATEWAY_DATABASE_URL:'postgres://synthetic'}).ZERNIO_PROFILE_ID,'profile')
})

test('resolves an Instagram handle from the actual participant of the scoped conversation',async()=>{
 let wrong=false
 const provider=createZernioClient('fixture',async input=>{
   const url=new URL(String(input))
   if(url.pathname.endsWith('/inbox/conversations/thread')){
     assert.equal(url.searchParams.get('accountId'),'account')
     return Response.json({data:{id:'thread',platform:'instagram',accountId:'account',participantId:'peer'}})
   }
   assert.ok(url.pathname.endsWith('/accounts/account/follow-status/peer'))
   return Response.json({accountId:'account',userId:wrong?'another':'peer',username:'koi.contact'})
 })
 assert.equal(await provider.instagramContact('account','thread'),'koi.contact')
 wrong=true
 await assert.rejects(provider.instagramContact('account','thread'),e=>(e as {code?:string}).code==='profile_mismatch')
})
