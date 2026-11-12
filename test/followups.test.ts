import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {readFile,readdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
const db=new PGlite(),user=randomUUID(),mate=randomUUID(),outsider=randomUUID(),w=randomUUID(),other=randomUUID(),lead=randomUUID(),foreignLead=randomUUID()
let chat:string,chat2:string
async function api<T=Record<string,unknown>>(feature:string,action:string,data:object={},actor=user):Promise<T>{return db.transaction(async tx=>{await tx.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${actor}',true)`);return (await tx.query<{result:T}>(`select public.koi_${feature}_command($1,$2) result`,[action,JSON.stringify(data)])).rows[0]!.result})}
async function stage(value?:string){if(value)await db.query('update koi_leads set stage=$1 where id=$2',[value,lead]);return (await db.query<{stage:string;revision:number;assigned_to:string|null;next_action:string}>('select stage,revision,assigned_to,next_action from koi_leads where id=$1',[lead])).rows[0]!}
async function message(direction='in',historical=false,body='Hola',status=direction==='in'?'received':'accepted') {return (await db.query<{seq:number}>("insert into koi_private.chat_messages(workspace_id,conversation_id,instance,direction,body,historical,status,provider_id) values($1,$2,'test', $3,$4,$5,$6,$7) returning seq",[w,chat,direction,body,historical,status,randomUUID()])).rows[0]!.seq}
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'))
 await db.query("insert into auth.users values($1,'studio@test.invalid'),($2,'mate@test.invalid'),($3,'other@test.invalid')",[user,mate,outsider])
 await db.query("insert into koi_workspaces(id,name) values($1,'Koi'),($2,'Otro')",[w,other])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'operator'),($4,$5,'admin')",[w,user,mate,other,outsider])
 await db.query("insert into koi_leads(id,workspace_id,phone,name,created_by) values($1,$2,'5493811111111','Lead',$3),($4,$5,'5493812222222','Foreign',$6)",[lead,w,user,foreignLead,other,outsider])
 await db.query("insert into koi_private.senders(workspace_id,instance) values($1,'test')",[w])
 chat=(await db.query<{id:string}>("insert into koi_conversations(workspace_id,instance,peer,phone,lead_id) values($1,'test','5493811111111@s.whatsapp.net','5493811111111',$2) returning id",[w,lead])).rows[0]!.id
 chat2=(await db.query<{id:string}>("insert into koi_conversations(workspace_id,instance,peer,phone,lead_id) values($1,'second','5493811111111@s.whatsapp.net','5493811111111',$2) returning id",[w,lead])).rows[0]!.id
})
after(()=>db.close())
test('live replies advance new/contacted only; history and opt-outs do not',async()=>{
 await message('in',true);assert.equal((await stage()).stage,'new')
 await message('in',false,'STOP');assert.equal((await stage()).stage,'new')
 await message();assert.equal((await stage()).stage,'replied')
 for(const s of ['interested','proposal','won','lost']){await stage(s);await message();assert.equal((await stage()).stage,s)}
 await stage('contacted');await message();assert.equal((await stage()).stage,'replied')
})
test('assignment propagates from lead or chat, supports unassigning and rejects outsiders',async()=>{
 await api('crm','update',{id:lead,revision:(await stage()).revision,assignedTo:mate})
 assert.deepEqual((await db.query<{assigned_to:string}>('select assigned_to from koi_conversations where lead_id=$1',[lead])).rows.map(r=>r.assigned_to),[mate,mate])
 await api('chat','update',{id:chat,assignedTo:user});assert.equal((await stage()).assigned_to,user)
 assert.equal((await db.query<{assigned_to:string}>('select assigned_to from koi_conversations where id=$1',[chat2])).rows[0]!.assigned_to,user)
 await api('chat','update',{id:chat,assignedTo:null});assert.equal((await stage()).assigned_to,null)
 await assert.rejects(api('chat','update',{id:chat,assignedTo:outsider}),/Invalid assignee/)
 await assert.rejects(api('chat','update',{id:chat,assignedTo:outsider},outsider),/missing|found/i)
})
test('contact totals and last contact include accepted chat sends but not failed or queued messages',async()=>{
 assert.equal((await api('crm','summary')).contacted,0)
 await message('out',false,'Esperando','queued');assert.equal((await api('crm','summary')).contacted,0)
 await message('out');assert.equal((await api('crm','summary')).contacted,1)
 await message('out');assert.equal((await api('crm','summary')).contacted,1)
 assert.ok((await api('crm','detail',{id:lead})).lastContactAt)
})
test('pending replies are independent of read state and owner filters are scoped to the caller',async()=>{
 const seq=await message();await api('chat','read',{id:chat,through:seq})
 assert.equal((await api<unknown[]>('chat','list',{pendingReply:true})).length,1)
 assert.equal((await api<unknown[]>('chat','list',{unread:true})).length,0)
 await message('out',false,'En cola','queued');assert.equal((await api<unknown[]>('chat','list',{pendingReply:true})).length,1)
 await message('out');assert.equal((await api<unknown[]>('chat','list',{pendingReply:true})).length,0)
 await api('chat','update',{id:chat,assignedTo:user})
 // chat2 no tiene mensajes: no aparece en la bandeja (solo el chat con mensajes).
 assert.equal((await api<unknown[]>('chat','list',{owner:'mine'})).length,1)
 assert.equal((await api<unknown[]>('chat','list',{owner:'mine'},mate)).length,0)
 assert.equal((await api<unknown[]>('chat','list',{},outsider)).length,0)
})
test('tasks are idempotent, versioned, completed/reopened, linked to the lead owner and isolated',async()=>{
 const input={leadId:lead,title:'Preparar propuesta',dueAt:'2020-01-01T15:00:00Z',key:randomUUID()}
 const t=await api<{id:string;revision:number}>('crm','task_create',input)
 assert.equal((await api('crm','task_create',input)).id,t.id)
 assert.equal((await api('crm','tasks',{view:'overdue',owner:'mine'})).total,1)
 assert.equal((await api('crm','tasks',{view:'today'})).total,0)
 assert.equal((await api('crm','tasks',{},outsider)).total,0)
 assert.equal((await stage()).next_action,input.title)
 await assert.rejects(api('crm','task_update',{id:t.id,revision:0,status:'completed'},outsider),/missing/i)
 const done=await api<{revision:number;completed_at:string}>('crm','task_update',{id:t.id,revision:t.revision,status:'completed'})
 assert.ok(done.completed_at);assert.equal((await stage()).next_action,'')
 await assert.rejects(api('crm','task_update',{id:t.id,revision:t.revision,title:'Stale'}),/Stale/)
 assert.equal((await api('crm','tasks',{view:'completed'})).total,1)
 await api('crm','task_update',{id:t.id,revision:done.revision,status:'pending',dueAt:null})
 assert.equal((await api('crm','tasks',{view:'overdue'})).total,0)
 await assert.rejects(api('crm','task_create',{...input,key:randomUUID(),leadId:foreignLead}),/missing/i)
 await db.exec('set role anon');try{await assert.rejects(db.query('select * from koi_followups'),/permission denied/)}finally{await db.exec('reset role')}
})

test('saved messages persist, filter literally, detect stale edits and archive/restore',async()=>{
 const input={title:'Apertura 100%',category:'Apertura',body:'Hola, somos Koi.\n¿Podemos conversar?',key:randomUUID()}
 const t=await api<{id:string;revision:number}>('crm','message_create',input)
 assert.equal((await api('crm','message_create',input)).id,t.id)
 await assert.rejects(api('crm','message_create',{...input,title:'Otro'}),/conflict/)
 assert.equal((await api('crm','messages',{search:'100%'})).total,1)
 assert.equal((await api('crm','messages',{category:'Negativa'})).total,0)
 const edited=await api<{revision:number}>('crm','message_update',{id:t.id,revision:0,body:'Gracias por tu tiempo.',category:'Negativa'})
 assert.equal(edited.revision,1)
 await assert.rejects(api('crm','message_update',{id:t.id,revision:0,title:'Viejo'}),/Stale/)
 await api('crm','message_update',{id:t.id,revision:1,archived:true})
 assert.equal((await api('crm','messages')).total,0)
 assert.equal((await api('crm','messages',{archived:true,category:'Negativa'})).total,1)
 await api('crm','message_update',{id:t.id,revision:2,archived:false})
 assert.equal((await api('crm','messages',{search:'gracias'})).total,1)
})
test('saved messages are shared with teammates and isolated from other workspaces',async()=>{
 assert.equal((await api('crm','messages',{},mate)).total,1)
 assert.equal((await api('crm','messages',{},outsider)).total,0)
 const t=(await api<{messages:{id:string;revision:number}[]}>('crm','messages')).messages[0]!
 await assert.rejects(api('crm','message_update',{...t,title:'Intruso'},outsider),/not found/)
 await api('crm','message_update',{id:t.id,revision:t.revision,title:'Equipo'},mate)
 await assert.rejects(api('crm','message_create',{title:' ',category:'Apertura',body:'Hola',key:randomUUID()}),/check constraint/)
 await assert.rejects(db.transaction(async tx=>{await tx.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${outsider}',true)`);await tx.query('insert into koi_saved_messages(workspace_id,title,category,body,request_id) values($1,$2,$3,$4,$5)',[w,'Intruso','Otro','Hola',randomUUID()])}),/row-level security/)
 await db.exec('set role anon');try{await assert.rejects(db.query('select * from koi_saved_messages'),/permission denied/)}finally{await db.exec('reset role')}
})
