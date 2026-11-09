import { before,after,test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { readdir,readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { campaignRoute } from '../src/campaigns/routes.ts'
import { crmUpdate,crmRoute } from '../src/crm.ts'
const db=new PGlite(),user=randomUUID(),other=randomUUID(),workspace=randomUUID(),foreign=randomUUID()
let first:string,base:string,secondBase:string
async function asUser<T>(actor:string,fn:()=>Promise<T>) {await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${actor}',false)`);try{return await fn()}finally{await db.exec('reset role;reset request.jwt.claim.sub')}}
async function command<T>(action:string,data:Record<string,unknown>={},actor=user) {return asUser(actor,async()=> (await db.query<{result:T}>('select koi_crm_command($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result)}
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 for(const f of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(f,dir),'utf8'))
 await db.query("insert into auth.users values($1,'equipo@example.test'),($2,'otro@example.test')",[user,other])
 await db.query("insert into koi_workspaces(id,name) values($1,'Koi'),($2,'Otro')",[workspace,foreign])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'operator'),($3,$4,'admin')",[workspace,user,foreign,other])
 const lists=await asUser(user,()=>db.query<{id:string}>("insert into koi_lead_lists(workspace_id,name,request_id) values($1,'Base A',gen_random_uuid()),($1,'Base B',gen_random_uuid()) returning id",[workspace]))
 base=lists.rows[0]!.id;secondBase=lists.rows[1]!.id
 for(let i=0;i<35;i++) {
  const row=await db.query<{id:string}>('insert into koi_leads(workspace_id,phone,name,company,email,created_by) values($1,$2,$3,$4,$5,$6) returning id',[workspace,'549381'+String(1000000+i),'Lead '+i,'Empresa '+i,`lead${i}@example.test`,user])
  const id=row.rows[0]!.id;if(i===0)first=id
  await db.query('insert into koi_lead_list_members(workspace_id,list_id,lead_id) values($1,$2,$3)',[workspace,base,id])
 }
 await db.query('insert into koi_lead_list_members(workspace_id,list_id,lead_id) values($1,$2,$3)',[workspace,secondBase,first])
})
after(()=>db.close())
test('global list and board count contacts once across bases and paginate all rows',async()=>{
 const page=await command<{leads:{id:string}[];total:number}>('list');assert.equal(page.total,35);assert.equal(page.leads.length,30)
 const tail=await command<typeof page>('list',{page:2});assert.equal(tail.leads.length,5);assert.equal(new Set([...page.leads,...tail.leads].map(l=>l.id)).size,35)
 const board=await command<{columns:{stage:string;total:number;leads:unknown[]}[]}>('board');assert.equal(board.columns.length,7);assert.equal(board.columns[0]!.total,35);assert.equal(board.columns[0]!.leads.length,30)
 assert.equal((await command<typeof page>('list',{listId:secondBase})).total,1)
 for(const search of ['Lead 0','Empresa 0','lead0@example.test','5493811000000'])assert.equal((await command<typeof page>('list',{search})).leads[0]!.id,first)
})
test('commercial updates synchronize board, filters and detail and reject stale revisions',async()=>{
 const updated=await command<{revision:number;stage:string;tags:string[]}>('update',{id:first,revision:0,stage:'interested',tags:['Web','Web','Tucumán'],assignedTo:user,nextAction:'Preparar propuesta',nextActionAt:'2026-11-10T15:00:00Z'})
 assert.equal(updated.revision,1);assert.equal(updated.tags.length,2)
 await assert.rejects(command('update',{id:first,revision:0,stage:'lost'}),/Stale contact/)
 assert.equal((await command<{total:number}>('list',{stage:'interested',tag:'Web',assignedTo:user})).total,1)
 const detail=await command<{lead:{stage:string};lists:unknown[]}>('detail',{id:first});assert.equal(detail.lead.stage,'interested');assert.equal(detail.lists.length,2)
 await assert.rejects(command('update',{id:first,revision:1,assignedTo:other}),/foreign key/)
 await assert.rejects(command('update',{id:first,revision:1,stage:'invented'}),/check constraint/)
})
test('notes persist idempotently and cross-workspace access stays isolated',async()=>{
 const key=randomUUID(),body='Pidió una propuesta.'
 const note=await command<{id:string;actor_id:string}>('note',{id:first,key,body})
 assert.equal(note.actor_id,user);assert.equal((await command<typeof note>('note',{id:first,key,body})).id,note.id)
 await assert.rejects(command('note',{id:first,key,body:'Changed'}),/Note key conflict/)
 assert.equal((await command<{total:number}>('notes',{id:first})).total,1)
 for(const action of ['detail','notes','history','update','note'])await assert.rejects(command(action,{id:first,revision:1,stage:'won',key:randomUUID(),body},other),/Contact not found/)
 assert.equal((await command<{total:number}>('list',{},other)).total,0)
 const opts=await command<{members:{label:string}[]}>('options');assert.deepEqual(opts.members.map(m=>m.label),['equipo@example.test'])
 await db.exec('set role anon');try{await assert.rejects(db.query("select koi_crm_command('list','{}')"),/permission denied/)}finally{await db.exec('reset role')}
})
test('CRM routes validate parameters before calling storage',async()=>{
 let calls=0;const command=async()=>{calls++;return {}}
 await assert.rejects(crmRoute({method:'GET'} as IncomingMessage,new URL('http://local/api/crm/leads?stage=bad'),command,async()=>({})))
 assert.equal(crmUpdate.safeParse({revision:0,workspace_id:foreign}).success,false)
 assert.equal(crmUpdate.safeParse({revision:0,tags:['x'.repeat(41)]}).success,false)
 assert.equal(calls,0)
})
test('duplicating a campaign creates only a draft request, preserves content and resets scheduled date',async()=>{
 const id=randomUUID(),listId=randomUUID(),key=randomUUID(),recipient=randomUUID()
 const cfg={intervalSeconds:30,perMinute:2,perHour:60,perDay:100,timezone:'America/Argentina/Tucuman',days:[1,2,3,4,5],startMinute:540,endMinute:1080,startsAt:'2026-11-09T12:00:00Z'}
 const calls:string[]=[]
 const response=await campaignRoute({method:'POST',headers:{'idempotency-key':key}} as unknown as IncomingMessage,new URL(`http://local/api/campaigns/${id}/duplicate`),async(action,data)=>{
  calls.push(action)
  if(action==='detail')return {campaign:{name:'Original',list_id:listId,template:'Hola {{nombre}}',selection:[recipient],config:cfg}}
  assert.equal(action,'create');assert.equal(data.key,key);assert.equal(data.listId,listId);assert.deepEqual(data.recipientIds,[recipient]);assert.equal(data.template,'Hola {{nombre}}');assert.equal((data.config as {startsAt:null}).startsAt,null)
  return {id:randomUUID(),status:'draft'}
 },async()=>({}))
 assert.equal(response.status,201);assert.deepEqual(calls,['detail','create'])
})
