import { after,before,test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID,createHash,createHmac } from 'node:crypto'
import { readdir,readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createInboxWebhook } from '../src/inbox/webhook.ts'
import { createInboxIngestCycle } from '../src/inbox/ingest-cycle.ts'
import { normalizeEvent,createZernioClient,accountRecord,ZernioError,type ZernioClient } from '../src/inbox/provider.ts'
import { createInboxService,safeConnectUrl } from '../src/inbox/service.ts'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'
import type { UserStore } from '../src/store.ts'
import type { IncomingMessage } from 'node:http'

const db=new PGlite(),w=randomUUID(),owner=randomUUID(),operator=randomUUID(),outsider=randomUUID(),other=randomUUID()
const profile='profile-koi'
const account={externalId:'ig-koi',profileId:profile,channel:'instagram',label:'Koi',address:'@koi',state:'connected',issue:null}
before(async()=>{
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'))
 await db.query('insert into auth.users(id) values($1),($2),($3)',[owner,operator,outsider])
 await db.query("insert into koi_workspaces(id,name) values($1,'Koi'),($2,'Other')",[w,other])
 await db.query("insert into koi_workspace_members values($1,$2,'admin'),($1,$3,'operator'),($4,$5,'admin')",[w,owner,operator,other,outsider])
 await db.query("insert into koi_private.inbox_bindings values(session_user,$1,$2,$3,'gateway')",[w,profile,owner])
})
after(()=>db.close())
function command(kind:'gateway'|'ingest'):MachineCommand{return async<T>(action:string,data:Record<string,unknown>)=>db.transaction(async tx=>{
 await tx.query('update koi_private.inbox_bindings set kind=$1 where role_name=session_user',[kind])
 await tx.exec(`set local role koi_inbox_${kind}`)
 return (await tx.query<{result:T}>('select koi_private.inbox_command($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result
})}
const gateway=command('gateway'),ingest=command('ingest')
const rejectsCode=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:unknown)=>(e as {code?:string}).code===code)
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function connect(record=account,key=randomUUID()){
 await gateway('begin_connect',{actorId:owner,channel:record.channel,hash:hash(key)})
 return gateway<{id:string}>('complete_connect',{actorId:owner,hash:hash(key),account:record})
}
function payload(event='message.received',messageId=randomUUID(),time=new Date().toISOString()){
 return {id:randomUUID(),event,timestamp:new Date().toISOString(),account:{id:'ig-koi',profileId:profile,platform:'instagram',username:'koi'},
 conversation:{id:'internal-thread',platformConversationId:'platform-thread',participantId:'person-ig',participantName:'Ana'},
 message:{id:'internal-'+messageId,platformMessageId:messageId,conversationId:'internal-thread',platform:'instagram',
 direction:event==='message.received'?'incoming':'outgoing',text:'Hola',sentAt:time,attachments:[],sender:{id:event==='message.received'?'person-ig':'business'}}}
}
async function enqueue(p:ReturnType<typeof payload>){await gateway('enqueue',{externalId:p.id,kind:p.event,hash:hash(JSON.stringify(p)),payload:p})}
type Delivery={id:string;lease:string;payload:unknown}

test('connection state is owner/workspace/channel bound, expires, and cannot attach a different account on replay',async()=>{
 const key=randomUUID()
 await rejectsCode(gateway('begin_connect',{actorId:operator,channel:'instagram',hash:hash(key)}),'42501')
 await gateway('begin_connect',{actorId:owner,channel:'instagram',hash:hash(key)})
 await rejectsCode(gateway('complete_connect',{actorId:outsider,hash:hash(key),account}),'42501')
 await rejectsCode(gateway('complete_connect',{actorId:owner,hash:hash(key),account:{...account,profileId:'another'}}),'42501')
 await rejectsCode(gateway('complete_connect',{actorId:owner,hash:hash(key),account:{...account,channel:'whatsapp'}}),'42501')
 const first=await gateway('complete_connect',{actorId:owner,hash:hash(key),account})
 assert.deepEqual(await gateway('complete_connect',{actorId:owner,hash:hash(key),account}),first)
 await rejectsCode(gateway('complete_connect',{actorId:owner,hash:hash(key),account:{...account,externalId:'another'}}),'42501')
 const expired=randomUUID()
 await gateway('begin_connect',{actorId:owner,channel:'instagram',hash:hash(expired)})
 await db.query("update koi_private.inbox_connect_states set expires_at=now()-interval '1 second' where hash=$1",[hash(expired)])
 await rejectsCode(gateway('complete_connect',{actorId:owner,hash:hash(expired),account}),'42501')
})

test('roles cannot access tables directly or invoke the other machine operations',async()=>{
 await rejectsCode(gateway('claim_event',{}),'42501')
 await rejectsCode(ingest('enqueue',{}),'42501')
 for(const role of ['anon','authenticated','koi_campaign_worker','koi_campaign_webhook','koi_chat_worker','koi_inbox_gateway','koi_inbox_ingest']){
  await rejectsCode(db.transaction(async tx=>{await tx.exec('set local role '+role);return tx.query('select * from koi_private.inbox_deliveries')}),'42501')
 }
 const list=await gateway<{accounts:unknown[]}>('list',{actorId:operator});assert.equal(list.accounts.length,1)
 await rejectsCode(gateway('list',{actorId:outsider}),'42501')
})

test('raw signature, header identity and persistence failure are checked before webhook acknowledgment',async()=>{
 const secret='test-only-secret'.repeat(4),p=payload(),raw=Buffer.from(JSON.stringify(p))
 const signature=createHmac('sha256',secret).update(raw).digest('hex')
 const hook=createInboxWebhook(secret,gateway)
 await assert.rejects(hook({'x-zernio-signature':signature},Buffer.from(raw+' ')))
 await assert.rejects(hook({'x-zernio-signature':signature,'x-zernio-event-id':'wrong'},raw))
 assert.deepEqual(await hook({'x-zernio-signature':signature},raw),{received:true})
 await hook({'x-zernio-signature':signature},raw)
 assert.equal((await db.query('select * from koi_private.inbox_deliveries where external_id=$1',[p.id])).rows.length,1)
 await assert.rejects(createInboxWebhook(secret,async()=>{throw new Error('database offline')})({'x-zernio-signature':signature},raw),/database offline/)
 await rejectsCode(gateway('enqueue',{externalId:p.id,kind:p.event,hash:hash('other'),payload:p}),'22023')
})

test('live delivery and historical page share platform IDs, preserve inbound time, and do not invent historical pending replies',async()=>{
 const d=await ingest<Delivery>('claim_event',{}),normalized=normalizeEvent(d.payload)
 assert.ok(normalized?.kind==='message')
 assert.equal(normalized.conversation.externalId,'platform-thread')
 await ingest('finish_event',{id:d.id,lease:d.lease,account,conversation:normalized.conversation,message:normalized.message})
 await rejectsCode(ingest('finish_event',{id:d.id,lease:d.lease,ignored:true}),'40001')
 const {rows:[conv]}=await db.query<{id:string;last_inbound_at:string;last_live_inbound_at:string}>('select * from koi_inbox_conversations')
 const original=conv!.last_inbound_at
 const a=(await gateway<{accounts:{id:string}[]}>('list',{actorId:owner})).accounts[0]!
 const job=await ingest<{id:string;lease:string}>('claim_sync',{})
 await ingest('finish_sync',{id:job.id,lease:job.lease,cursor:null,updatedSince:new Date(Date.now()-60000).toISOString(),conversations:[normalized.conversation,{externalId:'historic-thread',participantId:'person-old',displayName:'Old'}]})
 for(let i=0;i<2;i++){
  const next=await ingest<{id:string;lease:string;conversation_key:string}>('claim_sync',{})
  const old=next.conversation_key==='historic-thread'
  await ingest('finish_sync',{id:next.id,lease:next.lease,cursor:null,messages:[{...normalized.message,externalId:old?'historic-message':normalized.message.externalId,
   historical:true,sentAt:old?'2024-01-01T12:00:00Z':normalized.message.sentAt}]})
 }
 assert.equal((await db.query('select * from koi_private.inbox_messages where conversation_id=$1',[conv!.id])).rows.length,1)
 const current=(await db.query<{last_inbound_at:string}>('select * from koi_inbox_conversations where id=$1',[conv!.id])).rows[0]!
 assert.equal(new Date(current.last_inbound_at).getTime(),new Date(original).getTime())
 const history=(await db.query<{last_live_inbound_at:unknown;last_inbound_at:string}>("select * from koi_inbox_conversations where external_id='historic-thread'")).rows[0]!
 assert.equal(history.last_live_inbound_at,null)
 assert.equal(new Date(history.last_inbound_at).getUTCFullYear(),2024)
 assert.equal((await db.query('select * from koi_private.inbox_sync_jobs where account_id=$1',[a.id])).rows.length,1)
})

test('receipt order is monotonic, repeated message events are idempotent, future inbound never opens reply window',async()=>{
 const external=randomUUID()
 for(const event of ['message.read','message.sent','message.delivered','message.failed']){
  const p=payload(event,external);await enqueue(p)
  const d=await ingest<Delivery>('claim_event',{}),n=normalizeEvent(d.payload);assert.ok(n?.kind==='message')
  await ingest('finish_event',{id:d.id,lease:d.lease,account,conversation:n.conversation,message:n.message})
 }
 const row=(await db.query<{delivery:string}>('select delivery from koi_private.inbox_messages where external_id=$1',[external])).rows
 assert.equal(row.length,1);assert.equal(row[0]!.delivery,'read')
 const p=payload('message.received',randomUUID(),'2099-01-01T12:00:00Z');p.conversation.platformConversationId='future-thread'
 await enqueue(p);const d=await ingest<Delivery>('claim_event',{}),n=normalizeEvent(d.payload);assert.ok(n?.kind==='message')
 await ingest('finish_event',{id:d.id,lease:d.lease,account,conversation:n.conversation,message:n.message})
 assert.equal((await db.query<{last_inbound_at:unknown}>("select last_inbound_at from koi_inbox_conversations where external_id='future-thread'")).rows[0]!.last_inbound_at,null)
})

test('leases recover after interruption, error retry is bounded and a historical cursor commits atomically with its page',async()=>{
 await enqueue(payload())
 const first=await ingest<Delivery>('claim_event',{})
 await db.query("update koi_private.inbox_deliveries set lease_until=now()-interval '1 second' where id=$1",[first.id])
 const next=await ingest<Delivery>('claim_event',{});assert.equal(next.id,first.id);assert.notEqual(next.lease,first.lease)
 await rejectsCode(ingest('finish_event',{id:first.id,lease:first.lease,ignored:true}),'40001')
 await db.query('update koi_private.inbox_deliveries set attempts=8 where id=$1',[next.id])
 await ingest('fail_event',{id:next.id,lease:next.lease,code:'provider_rate_limited',retryAfter:60})
 assert.equal((await db.query<{status:string}>('select status from koi_private.inbox_deliveries where id=$1',[next.id])).rows[0]!.status,'failed')
 await gateway('retry',{actorId:owner});const retry=await ingest<Delivery>('claim_event',{})
 await ingest('finish_event',{id:retry.id,lease:retry.lease,ignored:true})
 await db.exec("update koi_private.inbox_sync_jobs set retry_at=now()")
 const sweep=await ingest<{id:string;lease:string}>('claim_sync',{})
 await ingest('finish_sync',{id:sweep.id,lease:sweep.lease,cursor:'page-2',conversations:[{externalId:'recovery',participantId:'recovery',displayName:'Recovery'}]})
 const job=(await db.query<{id:string}> ("select id from koi_private.inbox_sync_jobs where conversation_key='recovery'")).rows[0]!
 await db.query("update koi_private.inbox_sync_jobs set retry_at=now()-interval '1 day' where id=$1",[job.id])
 const claimed=await ingest<{id:string;lease:string}>('claim_sync',{});assert.equal(claimed.id,job.id)
 await rejectsCode(ingest('finish_sync',{id:job.id,lease:claimed.lease,cursor:'message-page-2',messages:[{externalId:'recovery-1',direction:'in',body:'ok',historical:true,sentAt:'2020-01-01T00:00:00Z'},
  {externalId:'recovery-2',direction:'bad',historical:true,sentAt:'2020-01-01T00:00:00Z'}]}),'23514')
 assert.equal((await db.query("select * from koi_private.inbox_messages where external_id='recovery-1'")).rows.length,0)
 assert.equal((await db.query<{cursor:unknown}>('select cursor from koi_private.inbox_sync_jobs where id=$1',[job.id])).rows[0]!.cursor,null)
 await ingest('finish_sync',{id:job.id,lease:claimed.lease,cursor:null,messages:[]})
})

test('provider requests use fixed origin, encoded identifiers and documented pagination; errors never expose provider bodies',async()=>{
 const requests:URL[]=[]
 const client=createZernioClient('synthetic-key',async(input,init)=>{
  const url=new URL(String(input));requests.push(url);assert.equal(url.origin,'https://zernio.com');assert.equal(init?.redirect,'error')
  if(url.pathname.includes('/connect/'))return Response.json({authUrl:'https://zernio.com/connect/whatsapp'})
  return Response.json({messages:[],pagination:{hasMore:false,nextCursor:null}})
 })
 await client.connect('whatsapp',profile,'https://koi.example/configuracion/conexiones?koiState=x')
 assert.equal(requests[0]!.searchParams.get('onboarding'),'api');assert.equal(requests[0]!.searchParams.get('scopes'),'messaging')
 await client.messages('account','opaque/../thread','opaque+cursor')
 assert.ok(requests[1]!.pathname.includes('opaque%2F..%2Fthread'));assert.equal(requests[1]!.searchParams.get('cursor'),'opaque+cursor')
 const limited=createZernioClient('synthetic-key',async()=>Response.json({error:'secret token'},{status:429,headers:{'Retry-After':'120'}}))
 await assert.rejects(limited.account('a'),(e:unknown)=>e instanceof ZernioError&&e.retryAfter===120&&!e.message.includes('secret'))
 assert.throws(()=>safeConnectUrl('https://evil.example/connect'));assert.throws(()=>safeConnectUrl('http://zernio.com/connect'))
 assert.throws(()=>accountRecord({_id:'a',platform:'instagram',profileId:'foreign',isActive:true},profile))
 assert.equal(accountRecord({_id:'a',platform:'instagram',profileId:profile,isActive:true,scopeAreas:['posting']},profile).state,'error')
})

test('worker validates account scope and historical pages, persists progress and classifies partial failures',async()=>{
 const calls:{action:string;data:Record<string,unknown>}[]=[]
 let eventPending=true,jobPending=true
 const c:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
  calls.push({action,data})
  if(action==='context')return {workspaceId:w,profileId:profile} as T
  if(action==='claim_event'&&eventPending){eventPending=false;return {id:'event',lease:'lease',payload:payload()} as T}
  if(action==='claim_sync'&&jobPending){jobPending=false;return {id:'job',lease:'lease',externalAccountId:'ig-koi',channel:'instagram',conversation_key:'',cursor:null} as T}
  return null as T
 }
 const provider={account:async()=>({_id:'ig-koi',profileId:profile,platform:'instagram',isActive:true}),
  conversations:async()=>({data:[],pagination:{hasMore:false,nextCursor:null},meta:{accountsFailed:1}})} as unknown as ZernioClient
 await createInboxIngestCycle(c,provider,{workspaceId:w,profileId:profile})()
 assert.ok(calls.some(c=>c.action==='finish_event'&&c.data.message))
 assert.ok(calls.some(c=>c.action==='fail_sync'&&c.data.code==='history_partial_failure'))
 assert.ok(!calls.some(c=>c.action==='finish_sync'))
})

test('connection service enforces admin and configured workspace before any provider call',async()=>{
 const admin={userId:owner,membership:{workspace_id:w,role:'admin'}} as UserStore
 let providerCalls=0
 const service=createInboxService({workspaceId:w,profileId:profile,origin:'https://koi.example',command:gateway,provider:{connect:async()=>{providerCalls++;return {authUrl:'https://zernio.com/connect/whatsapp'}}} as unknown as ZernioClient})
 const url=new URL('https://koi.example/api/inbox/connections/connect'),request={method:'POST'} as IncomingMessage
 await assert.rejects(service(request,url,{...admin,membership:{...admin.membership,role:'operator'}},async()=>({channel:'whatsapp'})))
 await assert.rejects(service(request,url,{...admin,membership:{...admin.membership,workspace_id:other}},async()=>({channel:'whatsapp'})))
 assert.equal(providerCalls,0)
 assert.deepEqual(await service(request,url,admin,async()=>({channel:'whatsapp'})),{url:'https://zernio.com/connect/whatsapp'})
})

test('WhatsApp and Instagram IDs remain account scoped and an explicit WhatsApp phone links an existing CRM lead',async()=>{
 const existing=randomUUID()
 await db.query("insert into koi_leads(id,workspace_id,phone,name,created_by) values($1,$2,'5493819999999','Existing CRM',$3)",[existing,w,owner])
 const wa={...account,externalId:'wa-koi',channel:'whatsapp'}
 await connect(wa)
 const sameId=randomUUID()
 for(const acc of [account,wa]){
  const p=payload('message.received',sameId)
  p.account.id=acc.externalId;p.account.platform=acc.channel;p.message.platform=acc.channel
  const raw={...p,message:{...p.message,sender:{id:'person-ig',phoneNumber:acc.channel==='whatsapp'?'+5493819999999':null}}}
  await gateway('enqueue',{externalId:p.id,kind:p.event,hash:hash(JSON.stringify(raw)),payload:raw})
  const d=await ingest<Delivery>('claim_event',{}),n=normalizeEvent(d.payload);assert.ok(n?.kind==='message')
  await ingest('finish_event',{id:d.id,lease:d.lease,account:acc,conversation:n.conversation,message:n.message,metadata:{referral:{source_id:'ad-123'}}})
 }
 const rows=(await db.query<{account_id:string;lead_id:string;channel:string}>("select * from koi_inbox_conversations where external_id='platform-thread'")).rows
 assert.equal(rows.length,2)
 assert.equal(rows.find(c=>c.channel==='whatsapp')!.lead_id,existing)
 assert.notEqual(rows.find(c=>c.channel==='instagram')!.lead_id,existing)
 assert.equal((await db.query('select * from koi_private.inbox_messages where external_id=$1',[sameId])).rows.length,2)
 assert.equal((await db.query("select * from koi_private.inbox_attribution where metadata#>>'{referral,source_id}'='ad-123'")).rows.length,2)
})

test('a failed outbound does not count as a successful reply and replayed failure cannot regress a delivered receipt',async()=>{
 const id=randomUUID()
 for(const event of ['message.sent','message.failed','message.delivered','message.failed']){
  const p=payload(event,id);p.conversation.platformConversationId='failed-reply-thread'
  await enqueue(p);const d=await ingest<Delivery>('claim_event',{}),n=normalizeEvent(d.payload);assert.ok(n?.kind==='message')
  await ingest('finish_event',{id:d.id,lease:d.lease,account,conversation:n.conversation,message:n.message})
  const c=(await db.query<{last_outbound_at:unknown}>("select last_outbound_at from koi_inbox_conversations where external_id='failed-reply-thread'")).rows[0]!
  if(event==='message.failed'&&(await db.query<{delivery:string}>('select delivery from koi_private.inbox_messages where external_id=$1',[id])).rows[0]!.delivery==='error')assert.equal(c.last_outbound_at,null)
  else assert.ok(c.last_outbound_at)
 }
})

test('out-of-scope platforms and samples are ignored while cached account states cannot override a newer check',async()=>{
 const facebook=payload('account.connected');facebook.account.platform='facebook'
 assert.equal(normalizeEvent(facebook),null)
 assert.equal(normalizeEvent({...payload(),test:true}),null)
 await gateway('refresh_account',{actorId:owner,account:{...account,state:'disconnected',checkedAt:new Date().toISOString()}})
 await gateway('refresh_account',{actorId:owner,account:{...account,state:'connected',checkedAt:'2020-01-01T00:00:00Z'}})
 const row=(await db.query<{checked_at:Date;state:string}>("select state,checked_at from koi_inbox_accounts where external_id='ig-koi'")).rows[0]!
 assert.equal(row.state,'disconnected')
 assert.ok(row.checked_at.getTime()>new Date('2020-01-01T00:00:00Z').getTime())
 const after=await gateway<{accounts:{state:string;external_id:string}[]}>('list',{actorId:owner})
 assert.equal(after.accounts.find(a=>a.external_id==='ig-koi')!.state,row.state)
})

test('a change discovered during a paginated message import schedules a fresh head scan instead of losing the change',async()=>{
 await db.exec("update koi_inbox_accounts set state='connected'; update koi_private.inbox_sync_jobs set retry_at=now()+interval '1 day'")
 const a=(await db.query<{id:string}>("select id from koi_inbox_accounts where external_id='ig-koi'")).rows[0]!
 const root=(await db.query<{id:string}>("select id from koi_private.inbox_sync_jobs where account_id=$1 and conversation_key=''",[a.id])).rows[0]!
 const conversation={externalId:'busy-history',participantId:'busy-person',displayName:'Busy'}
 await db.query("insert into koi_private.inbox_sync_jobs(workspace_id,account_id,conversation_key,conversation,cursor) values($1,$2,'busy-history',$3,'older-page')",[w,a.id,JSON.stringify(conversation)])
 const child=await ingest<{id:string;lease:string}>('claim_sync',{})
 await db.query('update koi_private.inbox_sync_jobs set retry_at=now() where id=$1',[root.id])
 const sweep=await ingest<{id:string;lease:string}>('claim_sync',{});assert.equal(sweep.id,root.id)
 await ingest('finish_sync',{id:sweep.id,lease:sweep.lease,cursor:null,updatedSince:new Date().toISOString(),conversations:[conversation]})
 await ingest('finish_sync',{id:child.id,lease:child.lease,cursor:null,messages:[]})
 const repeated=await ingest<{id:string;lease:string;cursor:unknown}>('claim_sync',{})
 assert.equal(repeated.id,child.id);assert.equal(repeated.cursor,null)
 await ingest('finish_sync',{id:repeated.id,lease:repeated.lease,cursor:null,messages:[]})
 assert.equal((await db.query('select id from koi_private.inbox_sync_jobs where id=$1',[child.id])).rows.length,0)
})
