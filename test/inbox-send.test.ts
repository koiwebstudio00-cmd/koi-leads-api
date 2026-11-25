import {before,after,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readdir,readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {seedInbox,inboxFixture as f} from './inbox-fixture.ts'
import {createInboxTextSender} from '../src/inbox/send-provider.ts'
import {createInboxSendCycle} from '../src/inbox/send-cycle.ts'
import {inboxReadRoute} from '../src/inbox/read.ts'
import type {ZernioClient} from '../src/inbox/provider.ts'
import type {MachineCommand} from '../src/campaigns/machine-store.ts'
import type {IncomingMessage} from 'node:http'
const db=new PGlite(),w=randomUUID(),user=randomUUID(),outsider=randomUUID()
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'))
 await db.query('insert into auth.users values($1),($2)',[user,outsider]);await db.query("insert into koi_workspaces(id,name) values($1,'Koi')",[w])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[w,user]);await seedInbox(db,w,user)
 await db.query("insert into koi_private.inbox_bindings values(session_user,$1,'profile',$2,'ingest')",[w,user])
})
after(()=>db.close())
beforeEach(async()=>{
 await db.exec("delete from koi_private.inbox_outbox;delete from koi_private.inbox_reads;delete from koi_private.inbox_messages where direction='out';update koi_inbox_accounts set state='connected';update koi_inbox_conversations set last_inbound_at=now()-interval '1 minute';")
})
async function enqueue(id=f.waChat,text='Hola',key=randomUUID(),actor=user){return db.transaction(async tx=>{
 await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor])
 return (await tx.query<{result:{id:string;status:string;clientKey:string}}>("select koi_inbox_send('send',$1) result",[JSON.stringify({id,text,requestId:key})])).rows[0]!.result
})}
const command:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>db.transaction(async tx=>{
 await tx.exec('set local role koi_inbox_ingest')
 return (await tx.query<{result:T}>('select koi_private.inbox_dispatch($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result
})
type Job={id:string;lease:string;accountId:string}
const claim=()=>command<Job|null>('claim',{})
const reject=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:unknown)=>(e as {code:string}).code===code)
test('send is scoped, durable and idempotent even after the reply window closes',async()=>{
 const key=randomUUID(),first=await enqueue(f.waChat,'Hola',key)
 assert.equal(first.status,'queued');assert.equal(first.clientKey,key)
 await db.exec("update koi_inbox_conversations set last_inbound_at=now()-interval '24 hours'")
 assert.equal((await enqueue(f.waChat,'Hola',key)).id,first.id)
 await reject(enqueue(f.waChat,'Distinto',key),'PT409');await reject(enqueue(),'PT422')
 await reject(enqueue(f.waChat,'Hola',randomUUID(),outsider),'42501')
 await reject(enqueue(randomUUID()),'PT404')
 assert.equal((await db.query('select * from koi_private.inbox_outbox')).rows.length,1)
})
test('leases preserve order within a conversation and permit other conversations',async()=>{
 await enqueue();await enqueue(f.waChat,'Segundo');await enqueue(f.igChat,'Instagram')
 const a=await claim(),b=await claim();assert.ok(a&&b);assert.notEqual(a.accountId,b.accountId);assert.equal(await claim(),null)
 await command('begin',a);await command('finish',{...a,outcome:'accepted',externalId:'accepted-first'})
 assert.ok(await claim())
})
test('dispatch rechecks expiry; expired queued messages never call the provider',async()=>{
 const message=await enqueue();const job=(await claim())!
 await db.exec("update koi_inbox_conversations set last_inbound_at=now()-interval '24 hours'")
 assert.equal(await command('begin',job),null)
 assert.equal((await db.query<{status:string}>('select status from koi_private.inbox_messages where id=$1',[message.id])).rows[0]!.status,'failed')
})
test('interrupted sending becomes unknown and blocks only that conversation; stale completion is ignored',async()=>{
 await enqueue();const job=(await claim())!;await command('begin',job)
 await db.exec("update koi_private.inbox_outbox set lease_until=now()-interval '1 minute'")
 assert.equal(await claim(),null);await reject(enqueue(),'PT423')
 assert.equal(await command('finish',{...job,outcome:'accepted',externalId:'stale'}),null)
 assert.equal((await db.query<{status:string}>('select status from koi_private.inbox_outbox')).rows[0]!.status,'unknown')
 await enqueue(f.igChat);assert.ok(await claim())
})
test('webhook before HTTP response merges by provider id and keeps delivery receipts and the local id',async()=>{
 const message=await enqueue();const job=(await claim())!;await command('begin',job)
 const duplicate=(await db.query<{id:string}>("insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,status,delivery) values($1,$2,$3,'provider-id','out','Hola',now(),'accepted','read') returning id",[w,f.wa,f.waChat])).rows[0]!.id
 await db.query('insert into koi_private.inbox_reads(workspace_id,conversation_id,user_id,through_message_id) values($1,$2,$3,$4)',[w,f.waChat,user,duplicate])
 await command('finish',{...job,outcome:'accepted',externalId:'provider-id'})
 const rows=(await db.query<{id:string;delivery:string}>("select id,delivery from koi_private.inbox_messages where direction='out'")).rows
 assert.deepEqual(rows,[{id:message.id,delivery:'read'}])
 assert.equal((await db.query<{through_message_id:string}>('select through_message_id from koi_private.inbox_reads')).rows[0]!.through_message_id,message.id)
})
test('unknown results can be reviewed without resending and workspace permissions remain enforced',async()=>{
 const message=await enqueue();const job=(await claim())!;await command('begin',job);await command('finish',{...job,outcome:'unknown',reason:'provider_timeout'})
 await db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);await tx.query("select koi_inbox_send('resolve_send',$1)",[JSON.stringify({id:f.waChat,messageId:message.id})])})
 assert.equal((await db.query<{status:string}>('select status from koi_private.inbox_outbox')).rows[0]!.status,'closed');await enqueue();assert.ok(await claim())
 await reject(db.transaction(async tx=>{await tx.exec('set local role authenticated');return tx.query("select koi_private.inbox_dispatch('claim','{}')")}), '42501')
 await reject(db.transaction(async tx=>{await tx.query("update koi_private.inbox_bindings set kind='gateway'");return tx.query("select koi_private.inbox_dispatch('claim','{}')")}), '42501')
})
test('sender posts only text with an idempotency key; uncertain responses are never retried',async()=>{
 const input={accountId:'account',conversationId:'opaque/thread',text:'Hola',requestId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString()}
 let calls=0
 const send=createInboxTextSender('secret',async(url,init)=>{calls++;assert.ok(String(url).includes('opaque%2Fthread'));assert.deepEqual(JSON.parse(String(init?.body)),{accountId:'account',message:'Hola'});assert.equal(new Headers(init?.headers).get('Idempotency-Key'),input.requestId);throw new Error('timeout')})
 assert.equal((await send(input)).outcome,'unknown');assert.equal(calls,1)
 for(const status of [500,502,409,408])assert.equal((await createInboxTextSender('secret',async()=>new Response('{}',{status}))(input)).outcome,'unknown')
 assert.equal((await createInboxTextSender('secret',async()=>new Response('{}',{status:400}))(input)).outcome,'failed')
 assert.equal((await createInboxTextSender('secret',async()=>new Response('{}',{status:429}))(input)).outcome,'queued')
 assert.equal((await createInboxTextSender('secret',async()=>new Response('{"success":true,"data":{"messageId":"external"}}'))(input)).outcome,'accepted')
 assert.equal((await send({...input,expiresAt:new Date(Date.now()-1).toISOString()})).outcome,'failed');assert.equal(calls,1)
})
test('worker checks provider profile and records ambiguous results without a second POST',async()=>{
 await enqueue()
 const provider={account:async()=>({_id:'fixture-wa',profileId:'profile',platform:'whatsapp',isActive:true})} as unknown as ZernioClient
 let calls=0
 const cycle=createInboxSendCycle(command,provider,async()=>{calls++;return {outcome:'unknown',reason:'provider_timeout'}},{profileId:'profile',workspaceId:w})
 await cycle();await cycle();assert.equal(calls,1)
 const row=(await db.query<{status:string}>('select status from koi_private.inbox_outbox')).rows[0]!;assert.equal(row.status,'unknown')
})
test('worker refuses a mismatched workspace before calling Zernio',async()=>{
 await enqueue();let calls=0
 const cycle=createInboxSendCycle(command,{} as ZernioClient,async()=>{calls++;return {outcome:'accepted',externalId:'never'}},{profileId:'profile',workspaceId:randomUUID()})
 await cycle();assert.equal(calls,0)
 assert.equal((await db.query<{reason:string}>('select reason from koi_private.inbox_outbox')).rows[0]!.reason,'profile_mismatch')
})
test('HTTP rejects extra recipient/template fields and forwards only validated text and request identity',async()=>{
 const key=randomUUID(),request={method:'POST',headers:{'idempotency-key':key}} as unknown as IncomingMessage,url=new URL('http://local/api/inbox/conversations/'+f.waChat+'/messages')
 let calls=0
 const query=async(action:string,data:Record<string,unknown>)=>{calls++;assert.equal(action,'send');assert.deepEqual(data,{id:f.waChat,text:'Hola',requestId:key});return {id:'queued'}}
 await assert.rejects(inboxReadRoute(request,url,query,async()=>({text:'Hola',accountId:'foreign'}),undefined,true))
 assert.equal(calls,0)
 await inboxReadRoute(request,url,query,async()=>({text:'Hola'}),undefined,true);assert.equal(calls,1)
})

test('an approved WhatsApp follow-up uses only the template payload after 24 hours and remains idempotent',async()=>{
 await db.exec("update koi_inbox_conversations set last_inbound_at=now()-interval '5 days'")
 await reject(enqueue(),'PT422')
 const template={name:'seguimiento',language:'es_AR',components:[]}
 const input={id:f.waChat,actorId:user,requestId:randomUUID(),accountId:'fixture-wa',template,text:'¿Pudiste ver la propuesta?'}
 const queue=(data:object)=>db.transaction(async tx=>{
   await tx.exec("update koi_private.inbox_bindings set kind='gateway' where role_name=session_user; set local role koi_inbox_gateway")
   const result=await tx.query<{message:{id:string}}>("select koi_private.inbox_followup_template('enqueue',$1) message",[JSON.stringify(data)])
   await tx.exec("reset role; update koi_private.inbox_bindings set kind='ingest' where role_name=session_user")
   return result.rows[0]!.message
 })
 const first=await queue(input)
 assert.equal((await queue(input)).id,first.id)
 await reject(queue({...input,template:{...template,name:'otro'}}),'PT409')
 await reject(queue({...input,id:f.igChat}),'PT404')
 await reject(queue({...input,actorId:outsider}),'42501')
 const calls:unknown[]=[]
 const sender=createInboxTextSender('fixture',async(_url,init)=>{
   calls.push(JSON.parse(String(init?.body)))
   return Response.json({success:true,data:{messageId:'template-accepted'}})
 })
 const provider={account:async()=>({_id:'fixture-wa',profileId:'profile',platform:'whatsapp',isActive:true})} as unknown as ZernioClient
 const cycle=createInboxSendCycle(command,provider,sender,{profileId:'profile',workspaceId:w})
 await cycle();await cycle()
 assert.deepEqual(calls,[{accountId:'fixture-wa',template:{elements:[template]}}])
 await reject(enqueue(),'PT422')
 assert.equal((await db.query<{status:string}>('select status from koi_private.inbox_messages where id=$1',[first.id])).rows[0]?.status,'accepted')
})
