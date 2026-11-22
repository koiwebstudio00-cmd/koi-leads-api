import { before,after,test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { readdir,readFile } from 'node:fs/promises'
import { prepare } from '../scripts/backoffice-stage.ts'
import { importFinance,bindFinanceOwners } from '../scripts/import-backoffice-finance.ts'
import { importDelivery } from '../scripts/import-backoffice-delivery.ts'
import { importCatalog,importClients } from '../scripts/import-backoffice-projects.ts'
import { randomUUID,randomBytes,createHash,createCipheriv } from 'node:crypto'
import { importVault } from '../scripts/import-backoffice-vault.ts'
import { unseal } from '../src/vault-crypto.ts'
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

test('projects allow independent interests, scoped responsibility, replay-safe corrections and historical audit',async()=>{
  const run=async(action:string,p:Record<string,unknown>,actor=user)=>asUser(actor,async()=>
    (await db.query<{result:any}>('select koi_project_command($1,$2) result',[action,p])).rows[0]!.result)
  const initial=(await command<{lead:{revision:number;stage:string}}>('detail',{id:first})).lead
  const fields={name:'Portal',type:'App',ownership:'studio',status:'active',start_date:null,deadline:null,key:randomUUID()}
  const project=await run('create',fields)
  assert.equal((await run('create',fields)).id,project.id)
  const saas=await run('create',{...fields,ownership:'saas',key:randomUUID()})
  assert.deepEqual(await run('list',{},other),[])
  await assert.rejects(run('detail',{projectId:project.id},other),/Project missing/)
  const add={leadId:first,projectId:project.id,assigned_to:user,reason:'Evaluación',key:randomUUID()}
  await assert.rejects(run('associate',{...add,assigned_to:other}),/foreign key/)
  const link=await run('associate',add)
  await run('associate',{...add,projectId:saas.id,key:randomUUID()})
  const edit={...add,key:randomUUID(),revision:link.revision,reason:'Demo agendada'}
  const corrected=await run('correct',edit)
  assert.equal((await run('associate',add)).revision,link.revision)
  await assert.rejects(run('correct',{...edit,key:randomUUID()}),/Interest changed/)
  assert.equal((await run('detail',{projectId:project.id})).leads[0].reason,'Demo agendada')
  assert.equal((await run('interests',{leadId:first})).length,2)
  const remove={leadId:first,projectId:project.id,revision:corrected.revision,key:randomUUID()}
  await run('remove',remove)
  await run('remove',remove)
  assert.equal((await run('interests',{leadId:first})).length,1)
  const current=(await command<{lead:{revision:number;stage:string}}>('detail',{id:first})).lead
  assert.deepEqual([current.revision,current.stage],[initial.revision,initial.stage])
  const audit=await db.query<{action:string;prior:string}>(`select action,previous->>'reason' prior from koi_private.project_events where payload->>'projectId'=$1 order by occurred_at`,[project.id])
  assert.deepEqual(audit.rows.map(r=>[r.action,r.prior]),[['associate',null],['correct','Evaluación'],['remove','Demo agendada']])
  await assert.rejects(asUser(user,()=>db.query('delete from koi_private.project_events')),/permission denied/)
})

test('catalog import uses reserved IDs, keeps customer provenance and preserves edits when replayed',async()=>{
  const stage=new PGlite()
  try{
    const clientId=randomUUID()
    const base={name:'Portal',type:'Plataforma SaaS',status:'active',start_date:'2026-06-01',deadline:null,
      created_at:'2026-06-01T12:00:00Z',updated_at:'2026-06-01T12:00:00Z',created_by:randomUUID()}
    const projects=[{...base,id:randomUUID(),client_id:clientId},{...base,id:randomUUID(),client_id:null}]
    await prepare(stage,'office',workspace,{clients:[{id:clientId,name:'Empresa'}],projects},true)
    const load=()=>db.transaction(tx=>importCatalog(stage,tx,'office',workspace))
    assert.equal((await load()).inserted,2)
    const stored=await db.query<{id:string;ownership:string;source_client_id:string;source_client_label:string}>(`select * from koi_private.studio_projects where source='office' order by ownership`)
    assert.equal(stored.rows[0]!.source_client_id,clientId)
    assert.equal(stored.rows[0]!.source_client_label,'Empresa')
    assert.deepEqual(stored.rows.map(p=>p.ownership),['client','saas'])
    const reserved=await stage.query<{target_id:string}>("select target_id from staging where entity='projects'")
    assert.deepEqual(new Set(stored.rows.map(p=>p.id)),new Set(reserved.rows.map(p=>p.target_id)))
    await db.query("update koi_private.studio_projects set name='Nombre revisado' where id=$1",[stored.rows[0]!.id])
    assert.equal((await load()).inserted,0)
    assert.equal((await db.query("select id from koi_private.studio_projects where name='Nombre revisado'")).rows.length,1)
  }finally{await stage.close()}
})

test('conversion is atomic, keeps separate contacts and supports shared SaaS and deferred contracts',async()=>{
 const run=async(action:string,p:Record<string,unknown>,actor=user)=>asUser(actor,async()=>
   (await db.query<{result:any}>('select koi_client_command($1,$2) result',[action,p])).rows[0]!.result)
 const leads=(await db.query<{id:string}>('select id from koi_leads where workspace_id=$1 order by id limit 3',[workspace])).rows
 const pid=(await db.query<{id:string}>("insert into koi_private.studio_projects(workspace_id,name,type,ownership,status) values ($1,'SaaS de prueba','App','saas','active') returning id",[workspace])).rows[0]!.id
 const args={leadId:leads[0]!.id,key:randomUUID(),name:'Cliente de prueba',projectId:pid}
 const otherProject=(await db.query<{id:string}>("insert into koi_private.studio_projects(workspace_id,name,type,ownership,status) values ($1,'Otro interés','App','saas','active') returning id",[workspace])).rows[0]!.id
 for(const project of [pid,otherProject])await db.query("insert into koi_private.project_interests(workspace_id,lead_id,project_id,reason,assigned_to) values($1,$2,$3,'Evaluación',$4)",[workspace,args.leadId,project,user])
 const beforeLead=(await db.query('select * from koi_leads where id=$1',[args.leadId])).rows[0]
 await assert.rejects(run('convert',{...args,projectId:randomUUID()}),/foreign key/)
 assert.deepEqual(await run('list',{}),[])
 const {clientId}=await run('convert',args)
 assert.equal((await run('convert',args)).clientId,clientId)
 await assert.rejects(run('convert',{...args,key:randomUUID()}),/Already converted/)
 await run('convert',{leadId:leads[1]!.id,key:randomUUID(),clientId})
 const second=await run('convert',{...args,name:'Segundo',leadId:leads[2]!.id,key:randomUUID(),projectId:null})
 await run('contract',{...second,projectId:pid,key:randomUUID()})
 assert.equal((await run('detail',{clientId})).contacts.length,2)
 assert.equal((await run('projectClients',{projectId:pid})).length,2)
 const leadState=await run('lead',{leadId:args.leadId})
 assert.equal(leadState.conversion.actor,'equipo@example.test')
 assert.deepEqual(leadState.contractedProjects,[pid])
 assert.equal((await db.query('select project_id from koi_private.project_interests where lead_id=$1 and project_id=$2',[args.leadId,otherProject])).rows.length,1)
 assert.deepEqual((await db.query('select * from koi_leads where id=$1',[args.leadId])).rows[0],beforeLead)
 await assert.rejects(run('convert',{...args,name:'Otro nombre'}),/Request changed/)
 await assert.rejects(run('detail',{clientId},other),/Client missing/)
 await assert.rejects(run('edit',{clientId,key:randomUUID(),revision:0,status:'paused',assigned_to:other}),/foreign key/)
 await run('edit',{clientId,key:randomUUID(),revision:0,status:'paused',assigned_to:user})
 assert.equal((await run('summary',{})).value,1)
})

test('delivery tracks progress, scoped files, meetings, comments and replay-safe conversion',async()=>{
 const run=async(action:string,p:Record<string,unknown>,actor=user)=>asUser(actor,async()=>
   (await db.query<{result:any}>('select koi_delivery_command($1,$2) result',[action,p])).rows[0]!.result)
 const [product,internal]=(await db.query<{id:string}>("insert into koi_private.studio_projects(workspace_id,name,type,ownership,status) values($1,'Producto','App','saas','active'),($1,'Interno','Web','studio','active') returning id",[workspace])).rows.map(r=>r.id)
 const [clientA,clientB]=(await db.query<{id:string}>("insert into koi_private.clients(workspace_id,name) values($1,'Cliente A'),($1,'Cliente B') returning id",[workspace])).rows.map(r=>r.id)
 await db.query('insert into koi_private.client_projects(workspace_id,client_id,project_id) values($1,$2,$4),($1,$3,$4)',[workspace,clientA,clientB,product])
 const create=(fields:Record<string,unknown>)=>run('create',{title:'Entrega de prueba',body:'Detalle',key:randomUUID(),projects:[],...fields})
 const idea=await create({kind:'improvement',status:'accepted',projectId:product,clientId:clientA})
 const study=await create({kind:'improvement',status:'proposed'})
 assert.equal((await run('detail',study)).client_id,null)
 await assert.rejects(run('convert',{...study,projectId:product,key:randomUUID()}),/Accepted improvement/)
 await run('comment',{...idea,key:randomUUID(),body:'Aceptada por el equipo'})
 const task=await run('convert',{...idea,key:randomUUID(),projectId:product})
 assert.deepEqual(await run('convert',{...idea,key:randomUUID(),projectId:product}),task)
 const converted=await run('detail',idea)
 assert.equal(converted.comments[0].author,user)
 assert.equal(converted.taskId,task.id)
 const edit={...task,key:randomUUID(),kind:'task',title:'Entregar',body:'',status:'done',due_date:'2026-12-01',revision:0,clientId:clientA,projectId:product}
 await run('edit',edit);await run('edit',edit)
 await assert.rejects(run('edit',{...edit,key:randomUUID()}),/Item changed/)
 assert.equal((await run('detail',task)).improvement_id,idea.id)
 assert.equal((await db.query<{status:string}>('select status from koi_private.studio_projects where id=$1',[product])).rows[0]!.status,'active')
 const meeting=await create({kind:'meeting',status:'scheduled',starts_at:'2026-12-02T12:00:00Z',projects:[product,internal]})
 assert.deepEqual(new Set((await run('detail',meeting)).projects),new Set([product,internal]))
 assert.ok((await run('list',{projectId:internal})).some((r:any)=>r.id===meeting.id))
 assert.ok(!(await run('list',{clientId:clientB})).some((r:any)=>r.id===idea.id))
 const milestone=await create({kind:'milestone',status:'todo',projectId:product,due_date:'2026-12-01'})
 const follow=(await db.query<{id:string}>("insert into public.koi_followups(workspace_id,lead_id,title,due_at,request_id,created_by) values($1,$2,'Llamar',now(),gen_random_uuid(),$3) returning id",[workspace,first,user])).rows[0]!
 const agenda=await run('agenda',{})
 for(const id of [meeting.id,milestone.id,follow.id])assert.ok(agenda.some((r:any)=>r.id===id))
 assert.ok(!agenda.some((r:any)=>r.id===task.id))
 assert.equal((await run('followup',follow)).lead_id,first)
 const bytes=Buffer.from('Contenido privado'),upload={key:randomUUID(),name:'contrato.txt',content:bytes.toString('base64'),projectId:product,clientId:clientA}
 const file=await run('upload',upload);assert.deepEqual(await run('upload',upload),file)
 const common=await run('upload',{...upload,key:randomUUID(),clientId:null})
 const studio=await run('upload',{...upload,key:randomUUID(),projectId:null,clientId:null})
 assert.deepEqual((await run('files',{})).map((r:any)=>r.id),[studio.id])
 assert.deepEqual((await run('files',{clientId:clientB})).map((r:any)=>r.id),[common.id])
 for(const scope of [{clientId:clientB},{projectId:product},{}])await assert.rejects(run('download',{...file,...scope}),/File missing/)
 const downloaded=await run('download',{...file,clientId:clientA})
 assert.deepEqual(Buffer.from(downloaded.content,'base64'),bytes)
 assert.equal(downloaded.digest,(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'))
 await assert.rejects(run('download',{...file,clientId:clientA},other),/File missing/)
 await assert.rejects(run('detail',idea,other),/Item missing/)
 await assert.rejects(asUser(user,()=>db.query('select content from koi_private.delivery_files')),/permission denied/)
 await db.exec('set role anon');try{await assert.rejects(db.query("select koi_delivery_command('agenda','{}')"),/permission denied/)}finally{await db.exec('reset role')}
})

test('delivery import preserves authors, dates, historical comments and multi-project meetings on replay',async()=>{
 const stage=new PGlite(),source='delivery-fixture',historical=randomUUID(),at='2025-01-15T13:50:00Z'
 const base={created_by:historical,created_at:at,updated_at:at}
 const projects=[1,2].map(n=>({...base,id:randomUUID(),name:'Proyecto importado '+n,type:'Software',status:'active',start_date:null,deadline:null,client_id:null}))
 const improvement={...base,id:randomUUID(),title:'Mejora histórica',description:'Descripción',status:'accepted'}
 const meeting={...base,id:randomUUID(),title:'Reunión previa',starts_at:at,ends_at:null,notes:'Acta',location:'Oficina'}
 const client={...base,id:randomUUID(),name:'Cliente histórico',company:null,email:null,phone:null,status:'active'}
 const snapshot={projects,clients:[client],client_memos:[{...client,notes:'Memo previo a la tabla de notas'}],
   notes:[{...base,id:client.id,client_id:client.id,body:'Otra nota con el mismo ID de origen'}],
   feature_requests:[improvement],meetings:[meeting],
   feature_request_comments:[{...base,id:randomUUID(),feature_request_id:improvement.id,body:'Comentario original'}],
   meeting_projects:projects.map(p=>({project_id:p.id,meeting_id:meeting.id}))}
 try{
   assert.equal((await prepare(stage,source,workspace,snapshot,true)).applied,true)
   await db.transaction(tx=>importCatalog(stage,tx,source,workspace))
   await db.transaction(tx=>importClients(stage,tx,source,workspace))
   const load=()=>db.transaction(tx=>importDelivery(stage,tx,source,workspace,snapshot))
   assert.equal((await load()).inserted,7)
   assert.deepEqual(await load(),{reviewed:7,inserted:0,existing:7})
   const memos=await db.query<{body:string;status:string;source:string}>(`select i.body,i.status,i.source
     from koi_private.delivery_items i join koi_private.clients c on c.id=i.client_id and c.workspace_id=i.workspace_id
     where c.workspace_id=$1 and c.source=$2 and c.source_id=$3 order by i.source`,[workspace,source,client.id])
   assert.deepEqual(memos.rows,[
     {body:snapshot.notes[0]!.body,status:'internal',source},
     {body:snapshot.client_memos[0]!.notes,status:'internal',source:source+':clients.notes'},
   ])
   const row=(await db.query<{id:string}>('select id from koi_private.delivery_items where workspace_id=$1 and source_id=$2',[workspace,improvement.id])).rows[0]!
   const detail=await asUser(user,async()=>(await db.query<{result:any}>("select koi_delivery_command('detail',$1) result",[row])).rows[0]!.result)
   assert.equal(detail.author,historical)
   assert.equal(detail.body,improvement.description)
   assert.equal(detail.comments[0].body,'Comentario original')
   assert.equal(detail.comments[0].author,historical)
   assert.equal(Date.parse(detail.comments[0].created_at),Date.parse(at))
   const linked=await db.query('select m.project_id from koi_private.delivery_meeting_projects m join koi_private.delivery_items i on i.workspace_id=m.workspace_id and i.id=m.item_id where i.source=$1 and i.source_id=$2',[source,meeting.id])
   assert.equal(linked.rows.length,2)
   const meetingId=(await db.query<{id:string}>('select id from koi_private.delivery_items where source=$1 and source_id=$2',[source,meeting.id])).rows[0]!.id
   await asUser(user,()=>db.query("select koi_delivery_command('edit',$1)",[{id:meetingId,key:randomUUID(),kind:'meeting',title:'Actualizada',status:'scheduled',starts_at:at,projects:[],revision:0}]))
   await load()
   assert.equal((await db.query('select project_id from koi_private.delivery_meeting_projects where item_id=$1',[meetingId])).rows.length,0)
 }finally{await stage.close()}
})

test('finance scopes, exact currency totals, recurrence, retries and owner-only access',async()=>{
 const admin=randomUUID()
 await db.query("insert into auth.users values($1,'admin@example.test')",[admin])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[workspace,admin])
 const run=async(action:string,p:Record<string,unknown>={},actor=user)=>asUser(actor,async()=>
   (await db.query<{result:any}>('select koi_finance_command($1,$2) result',[action,p])).rows[0]!.result)
 const origin=randomUUID(),verified=[{id:user,identity:'verified'}]
 await assert.rejects(bindFinanceOwners(db,'test',workspace,[{id:origin,identity:null}],verified),/verificar/)
 await db.transaction(tx=>bindFinanceOwners(tx,'test',workspace,[{id:origin,identity:'verified'}],verified))
 assert.equal(await run('access'),true)
 for(const actor of [admin,other]){assert.equal(await run('access',{},actor),false)
  for(const action of ['list','summary','due','create','edit','resolve','budget'])await assert.rejects(run(action,{},actor),/Finance access required/)
 }
 const project=(await db.query<{id:string}>("insert into koi_private.studio_projects(workspace_id,name,type,ownership,status) values($1,'Fin SaaS','App','saas','active') returning id",[workspace])).rows[0]!.id
 const customer=(await db.query<{id:string}>("insert into koi_private.clients(workspace_id,name) values($1,'Empresa F') returning id",[workspace])).rows[0]!.id
 await db.query("insert into koi_private.client_projects(workspace_id,project_id,client_id) values($1,$2,$3)",[workspace,project,customer])
 const movement={key:randomUUID(),projectId:project,clientId:customer,type:'income',status:'pending',concept:'Servicio mensual',category:'Suscripción',amount:'12345.00000001',
   currency:'USDT',payment_method:'crypto',occurred_on:'2040-01-31',due_date:'2040-01-31',settled_on:null,recurrence:'monthly',notes:''}
 const {id}=await run('create',movement)
 assert.equal((await run('create',movement)).id,id)
 await assert.rejects(run('create',{...movement,concept:'Otro'}),/Request conflict/)
 const resolve={key:randomUUID(),id,status:'settled',settled_on:'2040-02-01',revision:0}
 await run('resolve',resolve);await run('resolve',resolve)
 await assert.rejects(run('resolve',{...resolve,key:randomUUID()}),/Movement changed/)
 assert.equal((await run('list',{clientId:customer})).movements.length,2)
 const [next]=await run('due');assert.equal(next.due_date,'2040-02-29')
 const spend={...movement,key:randomUUID(),type:'expense',recurrence:'none',status:'settled',settled_on:'2040-02-01',amount:'350.50',currency:'ARS',clientId:null,projectId:null}
 await run('create',spend)
 const totals=(await run('summary',{from:'2040-02-01',to:'2040-02-01'})).totals
 assert.deepEqual(totals.map((t:any)=>[t.currency,t.net]),[['ARS','-350.50000000'],['USDT','12345.00000001']])
 assert.deepEqual((await run('summary',{from:'2040-01-01',to:'2040-01-31'})).totals,[])
 await run('edit',{...movement,key:randomUUID(),id,status:'settled',settled_on:'2040-02-02',revision:1,amount:'100.00000001'})
 assert.equal((await run('summary',{from:'2040-02-02',to:'2040-02-02'})).totals[0].income,'100.00000001')
 await run('budget',{key:randomUUID(),projectId:project,revision:-1,amount:'2200.20',currency:'USD'})
 assert.equal((await run('list',{projectId:project})).budgets[0].amount,'2200.20')
 assert.equal((await run('list',{clientId:customer})).budgets.length,0)
 const second={...resolve,key:randomUUID(),id:next.id,settled_on:'2040-02-29'}
 await run('resolve',second)
 assert.equal((await run('due')).length,1)
 await assert.rejects(asUser(admin,()=>db.query('select * from koi_private.finance_movements')),/permission denied/)
 await db.exec('set role anon');try{await assert.rejects(db.query("select koi_finance_command('summary','{}')"),/permission denied/)}finally{await db.exec('reset role')}
 await db.transaction(tx=>bindFinanceOwners(tx,'test',workspace,[],verified))
 await assert.rejects(run('summary'),/Finance access required/)
})

test('financial import reconciles historical rows separately from a missing next installment and is replay-safe',async()=>{
 const stage=new PGlite(),source='backoffice-finance-fixture',at='2030-04-01T10:00:00Z',id=randomUUID()
 const m={id,type:'income',status:'settled',concept:'Soporte',category:'Servicio',amount:'1.00000001',currency:'USDT',payment_method:'card',occurred_on:'2030-04-01',due_date:null,
 settled_on:'2030-04-08',notes:null,client_id:null,project_id:null,recurrence:'monthly',series_id:id,created_by:user,created_at:at,updated_at:at}
 const snapshot={financial_movements:[m],project_financials:[]}
 try{
  await prepare(stage,source,workspace,snapshot,true)
  const load=()=>db.transaction(tx=>importFinance(stage,tx,source,workspace,snapshot))
  const report=await load();assert.equal(report.reconciled,true);assert.equal(report.inserted,1);assert.equal((await load()).inserted,0)
  const rows=await db.query<{status:string;amount:string}>('select status,amount::text from koi_private.finance_movements where workspace_id=$1 and series_id=$2 order by occurred_on',[workspace,id])
  assert.deepEqual(rows.rows.map(r=>[r.status,r.amount]),[['settled','1.00000001'],['pending','1.00000001']])
 }finally{await stage.close()}
})

test('portal scopes published material and progress to each SaaS client and invalidates replaced links',async()=>{
 const [a,b,project,note,file]=Array.from({length:5},()=>randomUUID())
 await db.query("insert into koi_private.finance_owners(workspace_id,user_id,source,source_owner_id) values($1,$2,'portal',$2)",[workspace,user])
 const run=async(action:string,p:unknown,actor=user)=>asUser(actor,async()=>(await db.query<{value:any}>('select koi_sensitive_command($1,$2) as value',[action,p])).rows[0]!.value)
 await assert.rejects(run('vault_list',{},other),/Owner required/)
 await assert.rejects(asUser(user,()=>db.query('select * from koi_private.vault_entries')),/permission denied/)
 await db.query("insert into koi_private.clients(workspace_id,id,name) values($1,$2,'Cliente A'),($1,$3,'Cliente B')",[workspace,a,b])
 await db.query("insert into koi_private.studio_projects(workspace_id,id,name,type,ownership,status) values($1,$2,'Proyecto común','App','saas','active')",[workspace,project])
 await db.query('insert into koi_private.client_projects(workspace_id,client_id,project_id) values($1,$2,$4),($1,$3,$4)',[workspace,a,b,project])
 await db.query("insert into koi_private.delivery_items(workspace_id,id,client_id,project_id,kind,title,author,status) values($1,$2,$3,$4,'note','Solo B',$5,'internal'),($1,gen_random_uuid(),$3,$4,'task','Solo B',$5,'done')",[workspace,note,b,project,user])
 await db.query("insert into koi_private.delivery_files(workspace_id,id,client_id,project_id,name,content,author) values($1,$2,$3,$4,'Solo B','x',$5)",[workspace,file,b,project,user])
 const detail=await run('portal_detail',{clientId:a})
 assert.deepEqual(detail.available,[{kind:'project',id:project,label:'Proyecto común'}])
 await assert.rejects(run('portal_publish',{clientId:a,revision:0,choices:[{id:note,kind:'note'}]}),/Invalid selection/)
 async function rotate(clientId:string|undefined,revision:number){
   const token=randomBytes(32).toString('base64url')
   await run('portal_rotate',{clientId,revision,hash:createHash('sha256').update(token).digest('hex')})
   return token
 }
 async function read(token:string,fileId?:string){
   await db.exec('set role anon')
   try{return (await db.query<{value:any}>('select koi_read_client_portal($1,$2) as value',[token,fileId??null])).rows[0]!.value}
   finally{await db.exec('reset role')}
 }
 const token=await rotate(a,0)
 assert.deepEqual((await read(token)).items,[])
 await run('portal_publish',{clientId:a,choices:[{kind:'project',id:project}],revision:1})
 assert.equal((await read(token)).items[0].tasks,0)
 await assert.rejects(read(token,file),/File unavailable/)
 await assert.rejects(rotate(a,1),/Portal changed/)
 const replacement=await rotate(a,2)
 await assert.rejects(read(token),/Portal unavailable/)
 const otherToken=await rotate(b,0)
 await run('portal_publish',{clientId:b,choices:[{kind:'project',id:project},{kind:'file',id:file}],revision:1})
 const visible=await read(otherToken)
 assert.equal(visible.items.find((i:any)=>i.kind==='project').tasks,1)
 assert.equal((await read(otherToken,file)).name,'Solo B')
 await run('portal_revoke',{clientId:a,revision:3})
 await assert.rejects(read(replacement),/Portal unavailable/)
 assert.equal((await read(otherToken)).client,'Cliente B')
})

test('vault migration recovers legacy ciphertext, preserves history and rolls back with an incorrect recovery key',async()=>{
 const stage=new PGlite(),source='vault-test',credential=randomUUID(),log=randomUUID()
 const ring=()=>({active:1,keys:new Map([[1,randomBytes(32)]])}),old=ring(),destination=ring()
 const recovery={active:1,keys:new Map([[1,Buffer.from(destination.keys.get(1)!)]])}
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',old.keys.get(1)!,iv)
 const encrypted=Buffer.concat([cipher.update('synthetic passphrase'),cipher.final(),cipher.getAuthTag()])
 const row={id:credential,key_version:1,service_name:'Prueba',secret_iv:iv.toString('base64'),secret_ciphertext:encrypted.toString('base64'),created_by:user,created_at:new Date(),updated_at:new Date()}
 const snapshot={credentials:[row],project_env_files:[],credential_access_log:[{id:log,credential_id:credential,user_id:user,accessed_at:new Date()}],env_file_access_log:[]}
 try{
   await prepare(stage,source,workspace,snapshot,true)
   const load=(backup=recovery)=>db.transaction(tx=>importVault(stage,tx,source,workspace,snapshot,old,destination,backup))
   await assert.rejects(load(ring()))
   assert.deepEqual(await load(),{verified:1,inserted:1,accesses:1})
   assert.deepEqual(await load(),{verified:1,inserted:0,accesses:0})
   const stored=(await db.query<{envelope:string;id:string}>('select envelope,id from koi_private.vault_entries where source=$1',[source])).rows[0]!
   assert.equal(JSON.parse(unseal(recovery,{workspace,id:stored.id,kind:'credential'},1,stored.envelope)).value,'synthetic passphrase')
   assert.throws(()=>unseal(recovery,{workspace,id:randomUUID(),kind:'credential'},1,stored.envelope))
   const metadata=(await stage.query('select metadata from staging')).rows
   assert.ok(!JSON.stringify(metadata).includes(row.secret_ciphertext))
 }finally{await stage.close()}
})
