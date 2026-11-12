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

async function stats(data:object,actor=user){return db.transaction(async tx=>{await tx.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${actor}',true)`);return (await tx.query<{result:any}>('select public.koi_stats_command($1::jsonb) result',[JSON.stringify(data)])).rows[0]!.result})}
const window_=()=>({from:new Date(Date.now()-3600_000).toISOString(),to:new Date(Date.now()+3600_000).toISOString()})

test('stats count stage moves and accepted outbound contacts for the period',async()=>{
 await stage('interested')
 await message('out',false,'Hola','accepted')
 const s=await stats(window_())
 assert.ok(s.kpis.interested>=1,'interested')
 assert.ok(s.kpis.interestedOrWon>=1,'interestedOrWon')
 assert.ok(s.kpis.contacted>=1,'contacted')
 assert.ok(s.kpis.messagesSent>=1,'messagesSent')
 assert.ok(Array.isArray(s.daily)&&s.daily.length>=1,'daily')
})
test('stats are isolated by workspace and reject invalid periods',async()=>{
 const other=await stats(window_(),outsider)
 assert.equal(other.kpis.interested,0)
 assert.equal(other.kpis.contacted,0)
 const range=window_()
 await assert.rejects(stats({from:range.to,to:range.from}))
})
