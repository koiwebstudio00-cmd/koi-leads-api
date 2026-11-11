import { before,after,beforeEach,test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { readFile,readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseImport } from '../src/import-parser.ts'
import { prepareCommit } from '../src/import-service.ts'
import { suggestMapping, type ImportDraft, type ImportChoices } from '../src/contracts/imports.ts'
const db=new PGlite()
let user:string,w:string,base:string,ids:string[]
const cfg={intervalSeconds:30,perMinute:2,perHour:60,perDay:100,timezone:'America/Argentina/Tucuman',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,startsAt:null as string|null}
before(async()=>{
 await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;")
 for(const f of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('supabase/migrations/'+f,'utf8'))
})
after(()=>db.close())
beforeEach(async()=>{
 user=randomUUID();w=randomUUID();base=randomUUID()
 await db.query("insert into auth.users values($1,'test@example.test')",[user])
 await db.query("insert into koi_workspaces(id,name) values($1,'Synthetic')",[w])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[w,user])
 await db.query('select set_config($1,$2,false)',['request.jwt.claim.sub',user])
 await db.query("insert into koi_lead_lists(id,workspace_id,name,request_id,created_by) values($1,$2,'Base',gen_random_uuid(),$3)",[base,w,user])
 ids=(await db.query<{id:string}>("insert into koi_leads(workspace_id,phone,name,created_by) select $1,'549381'||lpad(n::text,7,'0'),'Lead '||n,$2 from generate_series(1,102) n returning id",[w,user])).rows.map(r=>r.id)
 await db.query('insert into koi_lead_list_members(workspace_id,list_id,lead_id) select workspace_id,$1,id from koi_leads where workspace_id=$2',[base,w])
 await db.query("insert into koi_private.senders(workspace_id,instance,enabled) values($1,$2,true)",[w,w])
 await db.exec('delete from koi_private.machine_bindings where role_name=session_user')
 await db.query("insert into koi_private.machine_bindings values(session_user,$1,'worker')",[w])
})
async function auth<T>(fn:()=>Promise<T>){await db.exec('set role authenticated');try{return await fn()}finally{await db.exec('reset role')}}
async function rpc<T=any>(name:string,action:string,data:object={}) {return auth(async()=>(await db.query<{r:T}>(`select ${name}($1,$2) r`,[action,JSON.stringify(data)])).rows[0]!.r)}
const crm=(a:string,d:object={})=>rpc('koi_crm_command',a,d)
const campaign=(a:string,d:object={})=>rpc('koi_campaign_command',a,d)
async function machine(a:string,d:object={}){return (await db.query<{r:any}>('select koi_private.worker_command($1,$2) r',[a,JSON.stringify({instance:w,...d})])).rows[0]!.r}
async function createCampaign(selection=ids.slice(0,2),config=cfg){return campaign('create',{key:randomUUID(),name:'Campaña',listId:base,recipientIds:selection,template:'Hola {{nombre}}',config})}
async function start(c:any){const p=await campaign('preview',{id:c.id});return campaign('start',{id:c.id,revision:c.revision,key:randomUUID(),fingerprint:p.fingerprint})}
async function finish(job:any){await machine('begin',{id:job.id,token:job.lease_token});await machine('finish',{id:job.id,token:job.lease_token,outcome:'accepted',providerId:randomUUID()});await db.query('update koi_private.senders set next_send_at=now() where workspace_id=$1',[w])}

test('two campaigns advance fairly; third is rejected including paused slots; cancelling releases capacity',async()=>{
 const a=await createCampaign(),b=await createCampaign(ids.slice(2,4)),c=await createCampaign(ids.slice(4,6))
 await start(a);await start(b);await assert.rejects(start(c),/Two campaigns already active/)
 const first=await machine('claim');assert.equal(first.campaign_id,a.id);await finish(first)
 const second=await machine('claim');assert.equal(second.campaign_id,b.id);await finish(second)
 await campaign('pause',{id:a.id});await assert.rejects(start(c),/Two campaigns already active/)
 await campaign('cancel',{id:a.id});await start(c)
 assert.equal((await db.query<{n:number}>("select count(*)::int n from koi_campaigns where workspace_id=$1 and status in ('scheduled','running','paused')",[w])).rows[0]!.n,2)
})
test('future schedule never blocks the other eligible campaign',async()=>{
 const a=await createCampaign(ids.slice(0,2),{...cfg,startsAt:new Date(Date.now()+86400000).toISOString()}),b=await createCampaign(ids.slice(2,4));await start(a);await start(b)
 assert.equal((await machine('claim')).campaign_id,b.id)
})
test('100 recipients accepted; explicit 101 and whole base of 102 rejected',async()=>{
 await assert.rejects(createCampaign(ids.slice(0,101)),/Invalid recipients/)
 const whole=await createCampaign([]);await assert.rejects(start(whole),/too many/)
 const c=await createCampaign(ids.slice(0,100));await start(c)
 assert.equal((await db.query<{n:number}>('select count(*)::int n from koi_campaign_recipients where campaign_id=$1',[c.id])).rows[0]!.n,100)
})
test('both campaigns share 100 daily attempts and existing 30 second spacing',async()=>{
 const a=await createCampaign(),b=await createCampaign(ids.slice(2,4));await start(a);await start(b)
 const job=await machine('claim');await machine('begin',{id:job.id,token:job.lease_token})
 const spacing=(await db.query<{s:number}>('select extract(epoch from next_send_at-now()) s from koi_private.senders where workspace_id=$1',[w])).rows[0]!.s
 assert.ok(Number(spacing)>28)
 await machine('finish',{id:job.id,token:job.lease_token,outcome:'accepted',providerId:'daily-test'})
 await db.query("update koi_private.message_attempts set started_at=date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman'+interval '1 second' where workspace_id=$1",[w])
 await db.query("insert into koi_private.message_attempts(recipient_id,attempt,workspace_id,started_at) select $1,n,$2,date_trunc('day',now() at time zone 'America/Argentina/Tucuman') at time zone 'America/Argentina/Tucuman'+interval '1 second' from generate_series(2,100) n",[job.id,w])
 await db.query('update koi_private.senders set next_send_at=now() where workspace_id=$1',[w])
 assert.equal(await machine('claim'),null)
})
test('manual create is idempotent, product filter works, duplicate phone is rejected',async()=>{
 const input={key:randomUUID(),phone:'5493819999999',name:'Manual',product:'toki',listIds:[base]}
 const a=await crm('create',input);assert.equal((await crm('create',input)).id,a.id)
 await assert.rejects(crm('create',{...input,key:randomUUID()}),/Phone exists/)
 const list=await crm('list',{product:'toki'});assert.equal(list.total,1);assert.equal(list.leads[0].id,a.id)
})
test('bulk edits are atomic, idempotent and refuse foreign and stale records',async()=>{
 const input={key:randomUUID(),operation:'update',leads:ids.slice(0,2).map(id=>({id,revision:0})),patch:{product:'cubiko',tags:['Cliente'],assignedTo:user}}
 assert.equal((await crm('bulk',input)).affected,2);assert.equal((await crm('bulk',input)).affected,2)
 await assert.rejects(crm('bulk',{...input,key:randomUUID(),patch:{product:'zyro'}}),/Stale contact/)
 await assert.rejects(crm('bulk',{...input,key:randomUUID(),leads:[{id:ids[2],revision:0},{id:randomUUID(),revision:0}]}),/Contact not found/)
 assert.equal((await crm('list',{product:'cubiko'})).total,2)
 assert.equal((await crm('detail',{id:ids[2]})).lead.product,'')
})
test('deletion removes pending recipients and memberships, preserves history and can restore by phone',async()=>{
 const c=await createCampaign();await start(c)
 await crm('bulk',{key:randomUUID(),operation:'delete',leads:[{id:ids[0],revision:0}]})
 await assert.rejects(crm('detail',{id:ids[0]}),/Contact not found/)
 assert.equal((await db.query<{status:string}>("select status from koi_campaign_recipients where campaign_id=$1 and lead_id=$2",[c.id,ids[0]])).rows[0]!.status,'skipped')
 assert.equal((await crm('list',{})).total,101)
 const restored=await crm('create',{key:randomUUID(),phone:'5493810000001',name:'Restored',product:'estudio',listIds:[base]})
 assert.equal(restored.id,ids[0])
})
test('lead operations require membership and cannot adopt a foreign list or grant privileges',async()=>{
 const stranger=randomUUID();await db.query('insert into auth.users(id) values($1)',[stranger]);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[stranger]);await assert.rejects(crm('create',{key:randomUUID(),phone:'5493819999998'}),/Not authorized/)
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await assert.rejects(crm('create',{key:randomUUID(),phone:'5493819999998',listIds:[randomUUID()]}),/Foreign list/)
 await assert.rejects(crm('create',{key:randomUUID(),phone:'5493819999998',workspace_id:randomUUID()}),/Invalid fields/)
 await db.exec('set role anon');try{await assert.rejects(db.query("select koi_manage_leads('create','{}')"),/permission denied/)}finally{await db.exec('reset role')}
})
test('import updates only selected fields after preview and rejects stale revisions',async()=>{
 const parsed=await parseImport(Buffer.from('Nombre,Telefono,Empresa\nNuevo nombre,+5493810000001,Empresa nueva'),{filename:'update.csv',sheet:1,headerRow:1,delimiter:',',encoding:'utf-8'})
 const staged=await auth(()=>db.query<{id:string}>('insert into koi_imports(workspace_id,payload) values($1,$2) returning id',[w,JSON.stringify(parsed)]))
 const draft:ImportDraft={...parsed,id:staged.rows[0]!.id,status:'draft',result:null,revision:0}
 const choices:ImportChoices={mapping:suggestMapping(parsed.headers),country:'AR',trim:true,edits:{},selected:[2],consents:{},target:{listId:base},updateFields:['name'],product:'zyro',expectedRevisions:{'5493810000001':0}}
 const prepared=prepareCommit(draft,choices)
 const preview=await auth(()=>db.query<{v:any[]}>('select koi_import_update_preview($1,$2,$3) v',[JSON.stringify(prepared.rows),'["name"]','zyro']))
 assert.equal(preview.rows[0]!.v[0].before.name,'Lead 1');assert.equal(preview.rows[0]!.v[0].after.name,'Nuevo nombre')
 const result=await auth(()=>db.query<{r:any}>('select koi_commit_import($1,$2,$3) r',[draft.id,randomUUID(),JSON.stringify(prepared)]))
 assert.equal(result.rows[0]!.r.updated,1)
 const lead=(await crm('detail',{id:ids[0]})).lead;assert.equal(lead.name,'Nuevo nombre');assert.equal(lead.company,'');assert.equal(lead.product,'zyro')
 const next=await auth(()=>db.query<{id:string}>('insert into koi_imports(workspace_id,payload) values($1,$2) returning id',[w,JSON.stringify(parsed)]))
 await assert.rejects(auth(()=>db.query('select koi_commit_import($1,$2,$3)',[next.rows[0]!.id,randomUUID(),JSON.stringify(prepared)])),/Stale contact/)
})

test('dashboard counts contacted leads once across campaigns and keeps campaign status totals',async()=>{
 const a=await createCampaign(ids.slice(0,1)),b=await createCampaign(ids.slice(0,1))
 await start(a);await start(b)
 await finish(await machine('claim'));await finish(await machine('claim'))
 const summary=await crm('summary')
 assert.equal(summary.leads,102);assert.equal(summary.contacted,1);assert.equal(summary.campaigns.running,2)
 await machine('tick',{enabled:true})
 assert.equal((await crm('summary')).campaigns.completed,2)
})

test('campaign finishes with failed and uncertain recipients without retrying either', async () => {
 const draft=await createCampaign(ids.slice(0,3))
 await start(draft)
 for (const [outcome,reason] of [['failed','not_on_whatsapp'],['unknown','network_or_timeout']] as const) {
  const job=await machine('claim')
  const reservation={id:job.id,token:job.lease_token}
  await machine('begin',reservation)
  await machine('finish',{...reservation,outcome,reason})
  await db.query("update koi_private.senders set next_send_at=now() where workspace_id=$1",[w])
  await db.query("update koi_private.message_attempts set started_at=now()-interval '2 minutes' where workspace_id=$1",[w])
 }
 await finish(await machine('claim'))
 await machine('tick',{enabled:true,workerId:'test'})
 const detail=await campaign('detail',{id:draft.id})
 assert.equal(detail.campaign.status,'completed')
 assert.equal(detail.sender.blocked,false)
 assert.equal(detail.reviewPending,2)
 const review=await campaign('recipients',{id:draft.id,status:'review'})
 assert.equal(review.total,2)
 assert.ok(review.recipients.every((recipient:{attempt:number})=>recipient.attempt===1))
 for (const recipient of review.recipients) await campaign('resolve',{id:draft.id,recipientId:recipient.id,decision:'do_not_resend'})
 assert.equal((await campaign('detail',{id:draft.id})).reviewPending,0)
 assert.equal(await machine('claim'),null)
})

test('a sender authorization failure still pauses its campaign', async () => {
 const draft=await createCampaign()
 await start(draft)
 const job=await machine('claim')
 const reservation={id:job.id,token:job.lease_token}
 await machine('begin',reservation)
 await machine('finish',{...reservation,outcome:'failed',reason:'provider_403'})
 const detail=await campaign('detail',{id:draft.id})
 assert.equal(detail.campaign.status,'paused')
 assert.equal(detail.campaign.pause_reason,'provider_unavailable')
 assert.equal(detail.counts.queued,1)
})

test('an Argentine number variant links a live reply and advances the matched lead', async () => {
 const lead=await db.query<{phone:string}>('select phone from koi_leads where id=$1',[ids[0]])
 const phone=lead.rows[0]!.phone.replace(/^549/,'54')
 await db.query("select koi_private.chat_ingest($1::uuid,$1::uuid::text,$2::jsonb)",[w,JSON.stringify({
  kind:'message',peer:phone+'@s.whatsapp.net',phone,providerId:randomUUID(),text:'Me interesa',
 })])
 assert.equal((await crm('detail',{id:ids[0]})).lead.stage,'replied')
 const linked=await db.query<{lead_id:string}>('select lead_id from koi_conversations where workspace_id=$1 and phone=$2',[w,phone])
 assert.equal(linked.rows[0]!.lead_id,ids[0])
})
