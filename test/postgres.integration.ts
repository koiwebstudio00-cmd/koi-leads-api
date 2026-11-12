import { listenForChat } from '../src/chat-worker-listener.ts'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Exclusivamente PostgreSQL local descartable: nunca lee una URL productiva del entorno.
const base='postgresql://postgres:koi_local_test_only@127.0.0.1:55439/'
const database=`koi_test_${Date.now()}`
const root=new Pool({connectionString:base+'postgres'})
let db:Pool; let worker:Pool; let hook:Pool; let chatWorker:Pool
const user=randomUUID(),workspace=randomUUID(),outsider=randomUUID(),list=randomUUID()
const first=randomUUID(),second=randomUUID(),denied=randomUUID()
const cfg={intervalSeconds:1,perMinute:60,perHour:3600,perDay:10000,timezone:'America/Argentina/Tucuman',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,startsAt:null}
async function api(action:string,data:Record<string,unknown>,actor=user,feature:'campaign'|'chat'='campaign'){
 const c=await db.connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);const r=await c.query(`select public.koi_${feature}_command($1,$2) as result`,[action,data]);await c.query('commit');return r.rows[0].result}catch(e){await c.query('rollback');throw e}finally{c.release()}
}
async function machine(action:string,data:Record<string,unknown>={},pool=action.startsWith('chat_')?chatWorker:worker){return (await pool.query('select koi_private.worker_command($1,$2) as result',[action,{instance:'koi-01',...data}])).rows[0].result}
async function campaign(template='Hola {{nombre}}'){
 await db.query("update public.koi_campaigns set status='cancelled' where status in ('running','scheduled','paused')")
 await db.query("update public.koi_campaign_recipients set status='cancelled',lease_token=null where status in ('leased','sending','unknown','queued')")
 await db.query("update koi_private.senders set blocked=false,next_send_at=now(),enabled=true")
 const input={name:'Prueba',listId:list,template,recipientIds:[],config:cfg,key:randomUUID()}
 return {c:await api('create',input),input}
}
async function start(c:{id:string;revision:number},key=randomUUID()){const preview=await api('preview',{id:c.id});return api('start',{id:c.id,revision:c.revision,key,fingerprint:preview.fingerprint})}
async function releaseRate(){await db.query("update koi_private.senders set next_send_at=now()-interval '1 second'")}
before(async()=>{
 await root.query(`create database ${database}`);db=new Pool({connectionString:base+database})
 await db.query(`do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;end$$;
 create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated;`)
 for(const file of (await readdir('supabase/migrations')).sort())await db.query(await readFile('supabase/migrations/'+file,'utf8'))
 await db.query('revoke usage on schema auth from koi_campaign_owner')
 await db.query('insert into auth.users values($1),($2)',[user,outsider])
 await db.query("insert into koi_workspaces(id,name) values($1,'Koi')",[workspace])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[workspace,user])
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user])
 await db.query("insert into koi_lead_lists(id,workspace_id,name,request_id,created_by) values($1,$2,'Test',gen_random_uuid(),$3)",[list,workspace,user])
 for(const [id,name,phone,consent] of [[first,'Ana','5493811111111','granted'],[second,'Beto','5493812222222','granted'],[denied,'Otro','5493813333333','unknown']]){
  await db.query('insert into koi_leads(id,workspace_id,phone,name,consent,created_by) values($1,$2,$3,$4,$5,$6)',[id,workspace,phone,name,consent,user])
  await db.query('insert into koi_lead_list_members(workspace_id,list_id,lead_id) values($1,$2,$3)',[workspace,list,id])
 }
 await db.query("insert into koi_private.senders(workspace_id,instance,min_interval,max_minute,max_hour,max_day) values($1,'koi-01',1,60,3600,10000)",[workspace])
 await db.query("insert into koi_private.machine_bindings values('koi_campaign_worker',$1,'worker'),('koi_campaign_webhook',$1,'webhook'),('koi_chat_worker',$1,'chat-worker')",[workspace])
 await db.query("alter role koi_campaign_worker login password 'local_worker_only';alter role koi_campaign_webhook login password 'local_hook_only'")
 await db.query("alter role koi_chat_worker login password 'local_chat_only';update koi_private.senders set chat_enabled=true,chat_heartbeat_at=now()")
 chatWorker=new Pool({connectionString:`postgresql://koi_chat_worker:local_chat_only@127.0.0.1:55439/${database}`,max:4})
 worker=new Pool({connectionString:`postgresql://koi_campaign_worker:local_worker_only@127.0.0.1:55439/${database}`,max:4})
 hook=new Pool({connectionString:`postgresql://koi_campaign_webhook:local_hook_only@127.0.0.1:55439/${database}`})
})
after(async()=>{
 await worker?.end();await hook?.end();await chatWorker?.end();await db?.end()
 // Esperar el cierre real de sockets antes de eliminar la base descartable.
 for(let attempt=0;attempt<50;attempt++){
  const active=await root.query('select count(*)::int n from pg_stat_activity where datname=$1',[database])
  if(active.rows[0].n===0)break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 await root.query(`drop database if exists ${database}`)
 await root.query('drop role if exists koi_chat_worker,koi_campaign_worker,koi_campaign_webhook,koi_campaign_owner')
 await root.end()
})
test('database validates auth, variables, preview and atomic idempotent start',async()=>{
 const {c,input}=await campaign()
 assert.equal((await api('create',input)).id,c.id)
 await assert.rejects(api('create',{...input,name:'Changed'}),/Idempotency conflict/)
 await assert.rejects(api('detail',{id:c.id},outsider),/Not authorized/)
 const preview=await api('preview',{id:c.id});assert.equal(preview.eligible,3);assert.equal(preview.excluded,0);assert.equal(preview.rows[0].message,'Hola Ana')
 const key=randomUUID();const payload={id:c.id,revision:c.revision,key,fingerprint:preview.fingerprint};await assert.rejects(api('start',{...payload,fingerprint:'00000000000000000000000000000000'}),/Preview changed/);const results=await Promise.all([api('start',payload),api('start',payload)]);assert.equal(results[0].id,results[1].id)
 assert.equal((await db.query('select count(*)::int n from koi_campaign_recipients where campaign_id=$1',[c.id])).rows[0].n,3)
 await assert.rejects(api('update',{...input,id:c.id,revision:0}),/Stale draft/)
})
test('two independent workers cannot claim same sender and receipts are durable, deduplicated and monotonic',async()=>{
 const {c}=await campaign();await start(c);await machine('tick',{enabled:true,workerId:'test'})
 const claimed=await Promise.all([machine('claim'),machine('claim')]);assert.equal(claimed.filter(Boolean).length,1)
 const job=claimed.find(Boolean);const reservation={id:job.id,token:job.lease_token}
 assert.equal((await machine('begin',reservation)).status,'sending')
 await machine('ingest',{eventKey:'read-before-response',kind:'receipt',providerId:'msg-1',delivery:'read'},hook)
 await machine('tick',{enabled:true});assert.equal((await db.query("select count(*)::int n from koi_private.evolution_events where processed_at is null")).rows[0].n,1)
 await machine('finish',{...reservation,outcome:'accepted',providerId:'msg-1'})
 await machine('tick',{enabled:true})
 await machine('ingest',{eventKey:'delivery-after-read',kind:'receipt',providerId:'msg-1',delivery:'delivered'},hook)
 await machine('ingest',{eventKey:'delivery-after-read',kind:'receipt',providerId:'msg-1',delivery:'delivered'},hook)
 await machine('tick',{enabled:true})
 assert.equal((await db.query('select delivery from koi_campaign_recipients where id=$1',[job.id])).rows[0].delivery,'read')
 assert.equal((await db.query('select count(*)::int n from koi_private.evolution_events')).rows[0].n,2)
 await assert.rejects(hook.query('select * from public.koi_campaigns'),/permission denied/)
 await assert.rejects(machine('claim',{},hook),/Worker required/)
})
test('pause/cancel fences leased work and running requests remain recorded',async()=>{
 const {c}=await campaign();await start(c);const job=await machine('claim');await api('pause',{id:c.id})
 assert.equal(await machine('begin',{id:job.id,token:job.lease_token}),null)
 await api('resume',{id:c.id});const next=await machine('claim');await machine('begin',{id:next.id,token:next.lease_token})
 await api('cancel',{id:c.id});await machine('finish',{id:next.id,token:next.lease_token,outcome:'accepted',providerId:'msg-cancel'})
 assert.equal((await api('detail',{id:c.id})).counts.accepted,1);assert.equal(await machine('claim'),null)
})
test('crash before send is recoverable; crash after begin is unknown and never auto retried',async()=>{
 const {c}=await campaign();await start(c);const job=await machine('claim')
 await db.query("update koi_campaign_recipients set lease_until=now()-interval '1 second' where id=$1",[job.id]);await machine('tick',{enabled:true})
 const retry=await machine('claim');assert.notEqual(retry.lease_token,job.lease_token)
 assert.equal(await machine('begin',{id:job.id,token:job.lease_token}),null)
 await machine('begin',{id:retry.id,token:retry.lease_token})
 await db.query("update koi_campaign_recipients set lease_until=now()-interval '1 second' where id=$1",[retry.id]);await machine('tick',{enabled:true})
 const detail=await api('detail',{id:c.id});assert.equal(detail.campaign.status,'running');assert.equal(detail.counts.unknown,1);assert.equal(detail.reviewPending,1)
 await releaseRate()
 const remaining=await machine('claim');assert.notEqual(remaining.id,retry.id)
})
test('persisted rate budget and local schedule cannot be bypassed by restart',async()=>{
 await db.query('delete from koi_private.message_attempts')
 const {c,input}=await campaign();const updated=await api('update',{...input,id:c.id,revision:0,config:{...cfg,perMinute:1}});await start(updated)
 const job=await machine('claim');await machine('begin',{id:job.id,token:job.lease_token});await machine('finish',{id:job.id,token:job.lease_token,outcome:'accepted',providerId:'rate-1'})
 await releaseRate();await machine('tick',{enabled:true,workerId:'restarted'});assert.equal(await machine('claim'),null)
 const window=await db.query("select koi_private.campaign_window($1,'2026-11-06T01:00:00Z') as next",[{...cfg,days:[1,2,3,4,5],startMinute:540,endMinute:1080}]);assert.equal(window.rows[0].next.toISOString(),'2026-11-06T12:00:00.000Z')
})
test('optout immediately excludes queued and leased contacts',async()=>{
 // Clear attempt history only inside the disposable test database to isolate rate limits.
 await db.query('delete from koi_private.message_attempts')
 const {c}=await campaign();await start(c);const job=await machine('claim')
 await machine('ingest',{eventKey:'optout',kind:'optout',phone:job.phone},hook)
 assert.equal(await machine('begin',{id:job.id,token:job.lease_token}),null)
 assert.equal((await db.query('select status from koi_campaign_recipients where id=$1',[job.id])).rows[0].status,'skipped')
})

test('concurrent starts reserve exactly two slots and both campaigns make progress',async()=>{
 await db.query('delete from koi_private.message_attempts')
 const {c,input}=await campaign()
 const b=await api('create',{...input,name:'Segunda',key:randomUUID()})
 const third=await api('create',{...input,name:'Tercera',key:randomUUID()})
 const results=await Promise.allSettled([start(c),start(b),start(third)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2)
 const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult
 assert.equal(rejected.reason.code,'PT429')
 const slots=await db.query("select active_slot from koi_campaigns where status in ('running','scheduled','paused') order by active_slot")
 assert.deepEqual(slots.rows.map(r=>r.active_slot),[1,2])
 const claims=await Promise.all([machine('claim'),machine('claim')])
 assert.equal(claims.filter(Boolean).length,1)
 const job=claims.find(Boolean)
 await machine('begin',{id:job.id,token:job.lease_token})
 await machine('finish',{id:job.id,token:job.lease_token,outcome:'accepted',providerId:'concurrent-first'})
 await releaseRate()
 const next=await machine('claim')
 assert.ok(next)
 assert.notEqual(next.campaign_id,job.campaign_id)
})


test('chat receives once, retains early receipts, and isolates messages and attachments by workspace',async()=>{
 const chat=(action:string,data:Record<string,unknown>,actor=user)=>api(action,data,actor,'chat')
 const thread=await chat('open',{leadId:first,instanceId:'primary'})
 const incoming={kind:'message',peer:'5493811111111@s.whatsapp.net',phone:'5493811111111',providerId:'chat-incoming',text:'Consulta de prueba'}
 await machine('chat_ingest',incoming,hook);await machine('chat_ingest',incoming,hook)
 const firstRead=await chat('detail',{id:thread.id})
 assert.equal(firstRead.messages.length,1);assert.equal(firstRead.conversation.unread,1)
 await chat('read',{id:thread.id,through:firstRead.messages[0].seq})
 assert.equal((await chat('detail',{id:thread.id})).conversation.unread,0)
 await assert.rejects(chat('detail',{id:thread.id},outsider),/Membership required/)
 await assert.rejects(machine('chat_ingest',{...incoming,instance:'foreign-instance'},hook),/Unknown instance/)
 await assert.rejects(machine('chat_claim',{},hook),/Worker required/)
 await assert.rejects(machine('chat_ingest',incoming),/Webhook required/)
 await machine('chat_ingest',{kind:'receipt',providerId:'early-outbound',delivery:'read'},hook)
 await machine('chat_ingest',{...incoming,providerId:'early-outbound',outbound:true,text:'Respuesta del teléfono'},hook)
 await machine('chat_ingest',{kind:'receipt',providerId:'early-outbound',delivery:'sent'},hook)
 assert.equal((await chat('detail',{id:thread.id})).messages[1].delivery,'read')
 const historical={...incoming,providerId:'historic-chat',text:'Mensaje de ayer',sentAt:'2026-01-01T12:00:00Z'}
 await machine('chat_history',{events:[historical]},hook)
 await machine('chat_history',{events:[historical]},hook)
 const history=await chat('detail',{id:thread.id})
 assert.equal(history.messages.length,3);assert.equal(history.messages[0].body,'Mensaje de ayer');assert.equal(history.conversation.unread,0)
 assert.deepEqual((await chat('detail',{id:thread.id,before:history.messages[1].seq})).messages.map((message:{body:string})=>message.body),['Mensaje de ayer'])
})

test('manual sending is idempotent, shares transport and does not consume campaign limits',async()=>{
 await db.query('delete from koi_private.message_attempts')
 await db.query('delete from public.koi_suppressions where workspace_id=$1',[workspace])
 const {c}=await campaign();await start(c)
 await db.query('update koi_private.senders set max_day=1 where workspace_id=$1',[workspace])
 const chat=(action:string,data:Record<string,unknown>)=>api(action,data,user,'chat')
 const thread=await chat('open',{leadId:second,instanceId:'primary'})
 const key=randomUUID(),base64=Buffer.from('%PDF-1.7 fixture').toString('base64')
 const input={id:thread.id,key,text:'Archivo de prueba',mime:'application/pdf',fileName:'prueba.pdf',base64}
 const queued=await chat('send',input)
 assert.equal((await chat('send',input)).id,queued.id)
 assert.equal((await chat('attachment',{id:thread.id,messageId:queued.id})).base64,base64)
 const reservation=await machine('chat_claim');assert.equal(reservation.id,queued.id)
 assert.equal(await machine('claim'),null)
 const lease={id:reservation.id,token:reservation.token}
 const payload=await machine('chat_begin',lease);assert.equal(payload.base64,base64)
 await machine('chat_ingest',{kind:'message',peer:'5493812222222@s.whatsapp.net',phone:'5493812222222',providerId:'manual-echo',outbound:true,text:'Archivo de prueba'},hook)
 await machine('chat_finish',{...reservation,outcome:'accepted',providerId:'manual-echo'})
 assert.equal((await chat('detail',{id:thread.id})).messages.length,1)
 await releaseRate();assert.ok(await machine('claim'))
})


async function resetDispatch() {
 await db.query("update koi_private.chat_messages set status='closed',lease_token=null,lease_until=null where status in ('queued','leased','sending','unknown')")
 await db.query("update koi_private.dispatch_instances set lane=null,job_id=null,token=null,lease_until=null,pause_until='-infinity',reason=null")
 await db.query('delete from koi_private.message_attempts')
 await db.query('delete from koi_suppressions')
 await db.query('update koi_private.senders set chat_enabled=true,chat_heartbeat_at=now(),max_day=10000,max_hour=3600,max_minute=60')
}
async function queueChat(leadId=first, text='Respuesta manual') {
 const thread=await api('open',{leadId,instanceId:'primary'},user,'chat')
 const message=await api('send',{id:thread.id,key:randomUUID(),text},user,'chat')
 return {thread,message}
}
async function finishChat(reservation:{id:string;token:string}, outcome='accepted', reason?:string) {
 const lease={id:reservation.id,token:reservation.token}
 const payload=await machine('chat_begin',lease)
 assert.ok(payload)
 await machine('chat_finish',{...lease,outcome,reason,...(outcome==='accepted'?{providerId:randomUUID()}: {})})
 return payload
}

test('manual messages ignore campaign disabled flag, exhausted budgets and future cooldown',async()=>{
 await resetDispatch();const {c}=await campaign();await start(c)
 await machine('tick',{enabled:false})
 await db.query("update koi_private.senders set next_send_at=now()+interval '1 day',max_day=1,max_hour=1,max_minute=1")
 const recipient=(await db.query('select id from koi_campaign_recipients where campaign_id=$1 limit 1',[c.id])).rows[0].id
 await db.query('insert into koi_private.message_attempts(recipient_id,attempt,workspace_id) values($1,1,$2)',[recipient,workspace])
 const before=(await db.query('select next_send_at from koi_private.senders')).rows[0].next_send_at
 for(let n=0;n<3;n++) {
  const {message}=await queueChat(first,'Rápido '+n)
  const reservation=await machine('chat_claim');assert.equal(reservation.id,message.id)
  await finishChat(reservation)
 }
 assert.equal((await db.query('select count(*)::int n from koi_private.message_attempts')).rows[0].n,1)
 assert.deepEqual((await db.query('select next_send_at from koi_private.senders')).rows[0].next_send_at,before)
 assert.equal(await machine('claim'),null)
})

test('chat priority is atomic across independent connections and preempts a campaign before begin',async()=>{
 await resetDispatch();const {c}=await campaign();await start(c)
 const reserved=await machine('claim');assert.ok(reserved)
 const {message}=await queueChat()
 assert.equal(await machine('begin',{id:reserved.id,token:reserved.lease_token}),null)
 assert.equal((await db.query('select attempt from koi_campaign_recipients where id=$1',[reserved.id])).rows[0].attempt,0)
 const [campaignJob,chatJob,otherChat]=await Promise.all([machine('claim'),machine('chat_claim'),machine('chat_claim')])
 assert.equal(campaignJob,null)
 const jobs=[chatJob,otherChat].filter(Boolean);assert.equal(jobs.length,1);assert.equal(jobs[0].id,message.id)
 await finishChat(jobs[0])
 assert.ok(await machine('claim'))
})

test('manual waits for a campaign HTTP attempt but not its following cooldown',async()=>{
 await resetDispatch();const {c}=await campaign();await start(c)
 const job=await machine('claim'),lease={id:job.id,token:job.lease_token}
 assert.ok(await machine('begin',lease))
 await queueChat(second)
 assert.equal(await machine('chat_claim'),null)
 await machine('finish',{...lease,outcome:'accepted',providerId:randomUUID()})
 await db.query("update koi_private.senders set next_send_at=now()+interval '10 minutes'")
 const chat=await machine('chat_claim');assert.ok(chat);await finishChat(chat)
})

test('unknown manual result blocks only that recipient and a real provider cooldown blocks the instance',async()=>{
 await resetDispatch();await campaign()
 await queueChat(first,'Incierto');await queueChat(first,'Debe esperar');const {message}=await queueChat(second,'Puede continuar')
 await finishChat(await machine('chat_claim'),'unknown','network_or_timeout')
 const next=await machine('chat_claim');assert.equal(next.id,message.id)
 await finishChat(next)
 assert.equal(await machine('chat_claim'),null)
 await queueChat(second,'Proveedor limita')
 const limited=await machine('chat_claim');await machine('chat_begin',limited)
 await machine('chat_finish',{...limited,outcome:'unknown',reason:'provider_429',retryAfterSeconds:60})
 await queueChat(denied,'Espera real')
 assert.equal(await machine('chat_claim'),null)
 assert.equal((await db.query('select reason from koi_private.dispatch_instances')).rows[0].reason,'provider_429')
})

test('expired pre-send leases recover once and stale tokens cannot send; in-flight expiry never retries',async()=>{
 await resetDispatch();await campaign();await queueChat()
 const old=await machine('chat_claim')
 await db.query("update koi_private.chat_messages set lease_until=now()-interval '1 second' where id=$1",[old.id])
 const next=await machine('chat_claim');assert.equal(next.id,old.id);assert.notEqual(next.token,old.token)
 assert.equal(await machine('chat_begin',old),null)
 assert.ok(await machine('chat_begin',next))
 await db.query("update koi_private.chat_messages set lease_until=now()-interval '1 second' where id=$1",[next.id])
 const other=await queueChat(second)
 const recovered=await machine('chat_claim');assert.equal(recovered.id,other.message.id)
 assert.equal((await db.query('select status from koi_private.chat_messages where id=$1',[next.id])).rows[0].status,'unknown')
 await finishChat(recovered)
 assert.equal(await machine('chat_claim'),null)
})

test('queue NOTIFY is committed, carries no message data, and chat role cannot run campaigns',async()=>{
 await resetDispatch();await campaign()
 const listener=await chatWorker.connect()
 try {
  await listener.query('LISTEN koi_chat_ready')
  const notification=new Promise<string>(resolve=>listener.once('notification',event=>resolve(event.payload??'')))
  await queueChat()
  assert.equal(await Promise.race([notification,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Missing notification')),1500))]),'')
  await assert.rejects(machine('claim',{},chatWorker),/Worker required/)
  await assert.rejects(machine('chat_claim',{},worker),/Worker required/)
  await assert.rejects(chatWorker.query('select * from koi_private.chat_messages'),/permission denied/)
  await listener.query('UNLISTEN *')
 } finally { listener.release() }
})


test('independent numbers progress while one is paused; same-conversation order is preserved',async()=>{
 await resetDispatch();await campaign()
 const instance=(await db.query("insert into koi_whatsapp_instances(workspace_id,label,request_id) values($1,'Segunda',gen_random_uuid()) returning id,instance_name",[workspace])).rows[0]
 const other=await api('open',{leadId:second,instanceId:instance.id},user,'chat')
 const a=await api('send',{id:other.id,key:randomUUID(),text:'Primero'},user,'chat')
 const b=await api('send',{id:other.id,key:randomUUID(),text:'Segundo'},user,'chat')
 await queueChat(first)
 await db.query("insert into koi_private.dispatch_instances(workspace_id,instance,pause_until) values($1,'koi-01',now()+interval '1 minute') on conflict(workspace_id,instance) do update set pause_until=excluded.pause_until",[workspace])
 const next=await machine('chat_claim',{account:instance.instance_name});assert.equal(next.id,a.id)
 await finishChat(next)
 const last=await machine('chat_claim',{account:instance.instance_name});assert.equal(last.id,b.id);await finishChat(last)
 assert.equal(await machine('chat_claim',{account:'koi-01'}),null)
})

test('normal inbound messages do not wait for campaign sender locks',async()=>{
 await resetDispatch();await campaign()
 const owner=await db.connect()
 await owner.query('begin');await owner.query('select 1 from koi_private.senders where workspace_id=$1 for update',[workspace])
 try {
  const inbound=machine('chat_ingest',{kind:'message',peer:'5493811111111@s.whatsapp.net',phone:'5493811111111',providerId:randomUUID(),text:'Recibido sin esperar'},hook)
  await Promise.race([inbound,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Inbound blocked by campaign lock')),500))])
 } finally {await owner.query('rollback');owner.release()}
})

test('stale chat worker heartbeat does not reserve campaign priority indefinitely',async()=>{
 await resetDispatch();const {c}=await campaign();await start(c);await queueChat()
 await db.query("update koi_private.senders set chat_heartbeat_at=now()-interval '2 minutes'")
 assert.ok(await machine('claim'))
})


test('dedicated LISTEN connection wakes on committed work and shuts down cleanly',async()=>{
 await resetDispatch();await campaign()
 const original=process.env.NODE_ENV;process.env.NODE_ENV='test'
 const abort=new AbortController();let notifications=0
 const listening=listenForChat(`postgresql://koi_chat_worker:local_chat_only@127.0.0.1:55439/${database}`,undefined,()=>{notifications++},abort.signal)
 try {
  for(let n=0;n<100&&notifications<1;n++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(notifications,1)
  await queueChat()
  for(let n=0;n<100&&notifications<2;n++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.ok(notifications>=2)
 } finally {abort.abort();await listening;if(original===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=original}
})
