import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// Exclusivamente Docker local: nunca lee una URL productiva del entorno.
const base='postgresql://postgres:koi_local_test_only@127.0.0.1:55439/'
const database=`koi_test_${Date.now()}`
const root=new Pool({connectionString:base+'postgres'})
let db:Pool; let worker:Pool; let hook:Pool
const user=randomUUID(),workspace=randomUUID(),outsider=randomUUID(),list=randomUUID()
const first=randomUUID(),second=randomUUID(),denied=randomUUID()
const cfg={intervalSeconds:1,perMinute:60,perHour:3600,perDay:10000,timezone:'America/Argentina/Tucuman',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,startsAt:null}
async function api(action:string,data:Record<string,unknown>,actor=user,feature:'campaign'|'chat'='campaign'){
 const c=await db.connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);const r=await c.query(`select public.koi_${feature}_command($1,$2) as result`,[action,data]);await c.query('commit');return r.rows[0].result}catch(e){await c.query('rollback');throw e}finally{c.release()}
}
async function machine(action:string,data:Record<string,unknown>={},pool=worker){return (await pool.query('select koi_private.worker_command($1,$2) as result',[action,{instance:'koi-01',...data}])).rows[0].result}
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
 await db.query("insert into koi_private.machine_bindings values('koi_campaign_worker',$1,'worker'),('koi_campaign_webhook',$1,'webhook')",[workspace])
 await db.query("alter role koi_campaign_worker login password 'local_worker_only';alter role koi_campaign_webhook login password 'local_hook_only'")
 worker=new Pool({connectionString:`postgresql://koi_campaign_worker:local_worker_only@127.0.0.1:55439/${database}`,max:4})
 hook=new Pool({connectionString:`postgresql://koi_campaign_webhook:local_hook_only@127.0.0.1:55439/${database}`})
})
after(async()=>{
 await worker?.end();await hook?.end();await db?.end()
 // Esperar el cierre real de sockets antes de eliminar la base descartable.
 for(let attempt=0;attempt<50;attempt++){
  const active=await root.query('select count(*)::int n from pg_stat_activity where datname=$1',[database])
  if(active.rows[0].n===0)break
  await new Promise(resolve=>setTimeout(resolve,20))
 }
 await root.query(`drop database if exists ${database}`)
 await root.query('drop role if exists koi_campaign_worker,koi_campaign_webhook,koi_campaign_owner')
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
 const detail=await api('detail',{id:c.id});assert.equal(detail.campaign.status,'paused');assert.equal(detail.counts.unknown,1)
 assert.equal(await machine('claim'),null);await assert.rejects(api('resume',{id:c.id}),/Cannot resume/)
 await api('resolve',{id:c.id,recipientId:retry.id,decision:'do_not_resend'});await api('resume',{id:c.id});await releaseRate()
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

test('manual sending is idempotent and shares dispatch and attempt limits with campaigns',async()=>{
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
 const payload=await machine('chat_begin',reservation);assert.equal(payload.base64,base64)
 await machine('chat_ingest',{kind:'message',peer:'5493812222222@s.whatsapp.net',phone:'5493812222222',providerId:'manual-echo',outbound:true,text:'Archivo de prueba'},hook)
 await machine('chat_finish',{...reservation,outcome:'accepted',providerId:'manual-echo'})
 assert.equal((await chat('detail',{id:thread.id})).messages.length,1)
 await releaseRate();assert.equal(await machine('claim'),null)
})
