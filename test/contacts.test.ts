import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { leadInput } from '../src/lead-input.ts'

const db = new PGlite()
const user=randomUUID(), outsider=randomUUID(), workspace=randomUUID(), otherWorkspace=randomUUID()
let list: string
const first=randomUUID(), second=randomUUID()
const config={intervalSeconds:30,perMinute:2,perHour:60,perDay:100,timezone:'America/Argentina/Tucuman',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,startsAt:null}
async function asUser<T>(actor:string,fn:()=>Promise<T>) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${actor}',false)`)
  try { return await fn() } finally { await db.exec('reset role; reset request.jwt.claim.sub') }
}
async function command<T>(action:string,data:Record<string,unknown>) {
  return asUser(user,async()=> (await db.query<{result:T}>('select koi_campaign_command($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result)
}
async function machine<T>(action:string,data:Record<string,unknown>={}) {
  return (await db.query<{result:T}>('select koi_private.worker_command($1,$2) result',[action,JSON.stringify({instance:'test-only',...data})])).rows[0]!.result
}
before(async()=>{
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`)
  const dir=new URL('../supabase/migrations/',import.meta.url)
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.query('insert into auth.users values($1),($2)',[user,outsider])
  await db.query("insert into koi_workspaces(id,name) values($1,'Koi'),($2,'Otro')",[workspace,otherWorkspace])
  await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'operator'),($3,$4,'admin')",[workspace,user,otherWorkspace,outsider])
  list = (await asUser(user,()=>db.query<{id:string}>("insert into koi_lead_lists(workspace_id,name,request_id) values($1,'Test',gen_random_uuid()) returning id",[workspace]))).rows[0]!.id
  for(const [id,phone] of [[first,'5493811111111'],[second,'5493812222222']]) {
    await db.query("insert into koi_leads(id,workspace_id,phone,name,created_by) values($1,$2,$3,'Prueba',$4)",[id,workspace,phone,user])
    await db.query('insert into koi_lead_list_members(workspace_id,list_id,lead_id) values($1,$2,$3)',[workspace,list,id])
  }
  await db.query("insert into koi_private.senders(workspace_id,instance) values($1,'test-only')",[workspace])
  await db.query("insert into koi_private.machine_bindings(role_name,workspace_id,kind) values(session_user,$1,'worker')",[workspace])
})
after(()=>db.close())

test('contact edits preserve identity and enforce workspace, duplicate phone and stale revision boundaries',async()=>{
  await asUser(user,async()=>{
    const r=await db.query<{revision:number}>("update koi_leads set name='Editado',company='Koi' where id=$1 and revision=0 returning revision",[first])
    assert.equal(r.rows[0]!.revision,1)
    assert.equal((await db.query("update koi_leads set name='Stale' where id=$1 and revision=0 returning id",[first])).rows.length,0)
    await assert.rejects(db.query("update koi_leads set phone='5493812222222' where id=$1",[first]),/duplicate key/)
    await assert.rejects(db.query('update koi_leads set workspace_id=$1 where id=$2',[otherWorkspace,first]),/permission denied/)
    await assert.rejects(db.query('update koi_leads set revision=0 where id=$1',[first]),/permission denied/)
  })
  await asUser(outsider,async()=>assert.equal((await db.query("update koi_leads set name='Attack' where id=$1 returning id",[first])).rows.length,0))
  await db.exec('set role anon')
  try { await assert.rejects(db.query("update koi_leads set name='Attack'"),/permission denied/) } finally { await db.exec('reset role') }
})

test('cold contacts pass preview, start and worker begin; later opt-out still prevents dispatch',async()=>{
  const c=await command<{id:string;revision:number}>('create',{name:'Cold test',listId:list,template:'Hola {{nombre}}',recipientIds:[],config,key:randomUUID()})
  const p=await command<{eligible:number;fingerprint:string}>('preview',{id:c.id})
  assert.equal(p.eligible,2)
  await command('start',{id:c.id,revision:c.revision,fingerprint:p.fingerprint,key:randomUUID()})
  await machine('tick',{enabled:true,workerId:'test'})
  const job=await machine<{id:string;lease_token:string}>('claim')
  assert.ok(job)
  const started=await machine<{status:string}>('begin',{id:job.id,token:job.lease_token})
  assert.equal(started.status,'sending')
  const stage = async () => (await db.query<{stage:string;revision:number}>('select l.stage,l.revision from koi_leads l join koi_campaign_recipients r on r.lead_id=l.id where r.id=$1',[job.id])).rows[0]!
  assert.equal((await stage()).stage,'new')
  await machine('finish',{id:job.id,token:job.lease_token,outcome:'accepted',providerId:'synthetic-1'})
  assert.equal((await stage()).stage,'contacted')
  const revision=(await stage()).revision
  await machine('finish',{id:job.id,token:job.lease_token,outcome:'accepted',providerId:'synthetic-1'})
  assert.equal((await stage()).revision,revision)
  await db.exec("update koi_private.senders set next_send_at=now()-interval '1 second'")
  const next=await machine<{id:string;phone:string;lease_token:string}>('claim')
  await db.query("insert into koi_suppressions(workspace_id,phone,reason) values($1,$2,'Test optout')",[workspace,next.phone])
  assert.equal(await machine('begin',{id:next.id,token:next.lease_token}),null)
  assert.equal((await db.query<{reason:string}>('select reason from koi_campaign_recipients where id=$1',[next.id])).rows[0]!.reason,'suppressed')
})

test('contact input normalizes phones and rejects invalid email, phone and injected fields',()=>{
  const input={revision:0,name:'Nombre',company:'',source:'',email:'',phone:'+54 9 381 1111111'}
  assert.equal(leadInput.parse(input).phone,'5493811111111')
  for(const bad of [{phone:'abc'},{email:'bad'},{workspace_id:workspace},{consent:'granted'},{revision:-1}])assert.equal(leadInput.safeParse({...input,...bad}).success,false)
})

test('only accepted transitions advance new leads; later stages and duplicate receipts are preserved',async()=>{
 const row=(await db.query<{id:string;lead_id:string}>("select id,lead_id from koi_campaign_recipients where status='skipped' limit 1")).rows[0]!
 for(const status of ['queued','sending','unknown','failed','cancelled','skipped']) {
  await db.query('update koi_campaign_recipients set status=$1 where id=$2',[status,row.id])
  assert.equal((await db.query<{stage:string}>('select stage from koi_leads where id=$1',[row.lead_id])).rows[0]!.stage,'new')
 }
 for(const stage of ['contacted','replied','interested','proposal','won','lost']) {
  await db.query('update koi_leads set stage=$1 where id=$2',[stage,row.lead_id])
  await db.query("update koi_campaign_recipients set status='sending' where id=$1",[row.id])
  await db.query("update koi_campaign_recipients set status='accepted' where id=$1",[row.id])
  assert.equal((await db.query<{stage:string}>('select stage from koi_leads where id=$1',[row.lead_id])).rows[0]!.stage,stage)
 }
 await db.query("update koi_leads set stage='new' where id=$1",[row.lead_id])
 const migration=await readFile(new URL('../supabase/migrations/20261106175306_koi_pipeline_contacted_automation.sql',import.meta.url),'utf8')
 await db.exec('begin;'+migration.slice(migration.indexOf('-- Reconcile')))
 assert.equal((await db.query<{stage:string}>('select stage from koi_leads where id=$1',[row.lead_id])).rows[0]!.stage,'contacted')
})
