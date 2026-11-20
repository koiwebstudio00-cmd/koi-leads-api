// Servidor exclusivo de pruebas: API/parser reales, PostgreSQL embebido y Auth sintética.
// Nunca se importa desde src/index.ts ni lee credenciales del entorno.
import { seedInbox } from './inbox-fixture.ts'
import {createInboxReactionCycle} from '../src/inbox/reactions.ts'
import type {InboxTextSender} from '../src/inbox/send-provider.ts'
import {createInboxSendCycle} from '../src/inbox/send-cycle.ts'
import type {ZernioClient} from '../src/inbox/provider.ts'
import { inboxQueryError,inboxRpc } from '../src/inbox/read.ts'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import { createApp } from '../src/app.ts'
import { chatError } from '../src/conversations.ts'
import { createWebhook } from '../src/campaigns/webhook.ts'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'
import { ApiError, type UserStore, type LeadList } from '../src/store.ts'
import { prepareCommit,validateDraftChoices } from '../src/import-service.ts'
import type { ImportCheck, ImportDraft, ImportResult, Lead, ParsedImport, RecentImport } from '../src/contracts/imports.ts'

if (process.env.KOI_BROWSER_TEST !== '1') throw new Error('Este servidor sólo se ejecuta desde Playwright con KOI_BROWSER_TEST=1')
const user = '11111111-1111-4111-8111-111111111111'
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const db = new PGlite()
await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
  insert into auth.users values('${user}');`)
const directory = new URL('../supabase/migrations/',import.meta.url)
for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,directory),'utf8'))
await db.exec(`insert into public.koi_workspaces(id,name) values('${workspace}','Estudio Koi'); insert into public.koi_workspace_members values('${workspace}','${user}','admin',now())`)
await seedInbox(db,workspace,user)
await db.query("update koi_private.inbox_messages set provider_attachments=provider_attachments || $1::jsonb where external_id='live'",[JSON.stringify([{type:'audio',mimeType:'audio/wav',filename:'tono.wav'},{type:'sticker',mimeType:'image/webp',filename:'sticker.webp'}])])
await db.query("insert into koi_private.inbox_bindings values(session_user,$1,'browser-profile',$2,'ingest')",[workspace,user])
const dispatch:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>(await db.query<{result:T}>('select koi_private.inbox_dispatch($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result
const browserProvider={account:async(id:string)=>({_id:id,profileId:'browser-profile',platform:id==='fixture-wa'?'whatsapp':'instagram',isActive:true})} as unknown as ZernioClient
const fixtureSend:InboxTextSender = async input=>input.text==='fixture-unknown'?{outcome:'unknown',reason:'provider_timeout'}:{outcome:'accepted',externalId:'fixture-'+input.requestId}
fixtureSend.upload=async()=> 'https://fixture.invalid/upload'
const binding={profileId:'browser-profile',workspaceId:workspace,richEnabled:true}
const sendCycle=createInboxSendCycle(dispatch,browserProvider,fixtureSend,binding)
const reactDispatch:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>(await db.query<{result:T}>('select koi_private.inbox_reaction_dispatch($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result
const reactCycle=createInboxReactionCycle(reactDispatch,browserProvider,'synthetic',binding,undefined,async()=>Response.json({success:true}))
let sending=false
const sendTimer=setInterval(()=>{if(sending)return;sending=true;void Promise.all([sendCycle(),reactCycle()]).finally(()=>{sending=false})},100)
async function query<T>(fn:(tx:Transaction) => Promise<T>):Promise<T> {
  return db.transaction(async tx => {
    await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${user}',true)`)
    try { return await fn(tx) }
    catch (error) {
      const code = (error as { code?:string }).code
      if (code === '23505' || code === 'PT409') throw new ApiError(409,'Conflicto de importación o nombre duplicado.')
      if (code === '42501') throw new ApiError(403,'Sin permiso.')
      throw error
    }
  })
}
async function draft(tx:Transaction,id:string):Promise<ImportDraft> {
  const row = (await tx.query<{ id:string;payload:ParsedImport;status:'draft'|'committed';result:ImportResult|null;choices:ImportDraft['choices'];revision:number }>('select id,payload,status,result,choices,revision from koi_imports where id=$1 and created_by=$2',[id,user])).rows[0]
  if (!row) throw new ApiError(404,'Importación no encontrada.')
  return { ...row.payload,id:row.id,status:row.status,result:row.result,choices:row.choices,revision:row.revision }
}
await db.query('insert into koi_private.senders(workspace_id,instance) values($1,$2)',[workspace,'test-only'])
await db.query("insert into koi_private.machine_bindings values(session_user,$1,'webhook')",[workspace])
const inbound:MachineCommand=async <T>(action:string,data:Record<string,unknown>) =>
  (await db.query<{result:T}>('select koi_private.worker_command($1,$2) as result',[action,JSON.stringify(data)])).rows[0]!.result
const store:UserStore = {
  inbox:(action,data)=>query(async tx=>{
    try{
      const {name,args}=inboxRpc(action,data)
      const params='action' in args?[action,JSON.stringify(data)]:[JSON.stringify(data)]
      return (await tx.query<{result:unknown}>(`select ${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) result`,params)).rows[0]!.result
    }
    catch(error){inboxQueryError(error as {code?:string})}
  }),
  chat:(action,data) => query(async tx => {
    try { return (await tx.query<{result:unknown}>('select koi_chat_command($1,$2) as result',[action,JSON.stringify(data)])).rows[0]!.result }
    catch (error) { chatError(error as {code?:string;message?:string}) }
  }),
  crm:(action,data) => query(async tx => {
    if (action === 'stats') {
      return (await tx.query<{result:unknown}>('select koi_stats_command($1) as result',[JSON.stringify(data)])).rows[0]!.result
    }
    if (action === 'campaign_recipients') {
      return (await tx.query<{result:unknown}>('select koi_campaign_recipient_picker($1,$2,$3,$4,$5,$6) as result',
        [data.listId,data.search,data.province,data.contact,data.page,data.selected??null])).rows[0]!.result
    }
    return (await tx.query<{result:unknown}>('select koi_crm_command($1,$2) as result',[action,JSON.stringify(data)])).rows[0]!.result
  }),
  campaigns:(action,data) => query(async tx => (await tx.query<{result:unknown}>('select koi_campaign_command($1,$2) as result',[action,JSON.stringify(data)])).rows[0]!.result),
  userId:user,membership:{ workspace_id:workspace,workspace_name:'Estudio Koi',role:'admin' },
  list:(page,search) => query(async tx => ({ lists:(await tx.query<LeadList>('select * from koi_lead_lists where name ilike $1 order by created_at desc,id desc limit 24 offset $2',[`%${search}%`,(page-1)*24])).rows,total:Number((await tx.query<{ n:number }>('select count(*) as n from koi_lead_lists where name ilike $1',[`%${search}%`])).rows[0]!.n) })),
  create:(input,key) => query(async tx => (await tx.query<LeadList>('insert into koi_lead_lists(workspace_id,name,description,request_id) values($1,$2,$3,$4) returning *',[workspace,input.name,input.description,key])).rows[0]!),
  update:(id,input) => query(async tx => (await tx.query<LeadList>('update koi_lead_lists set name=$1,description=$2 where id=$3 returning *',[input.name,input.description,id])).rows[0]!),
  imports:{
    updateContact:(id,{revision,...input}) => query(async tx => {
      const row=(await tx.query<{id:string;revision:number}>('update koi_leads set name=$1,phone=$2,company=$3,email=$4,source=$5 where id=$6 and revision=$7 and deleted_at is null returning id,revision',[input.name,input.phone,input.company,input.email,input.source,id,revision])).rows[0]
      if(!row)throw new ApiError(409,'El contacto cambió. Actualizá la base.')
      return row
    }),
    recent:() => query(async tx => (await tx.query<RecentImport>('select id,filename,status,created_at from koi_imports where created_by=$1 order by created_at desc limit 10',[user])).rows),
    stage:payload => query(async tx => {
      const inserted = (await tx.query<{ id:string }>('insert into koi_imports(workspace_id,payload) values($1,$2) returning id',[workspace,JSON.stringify(payload)])).rows[0]!
      return draft(tx,inserted.id)
    }),
    draft:id => query(tx => draft(tx,id)),
    save:(id,revision,input) => query(async tx => {
      const choices = validateDraftChoices(await draft(tx,id),input)
      return { revision:(await tx.query<{ revision:number }>('select koi_save_import_draft($1,$2,$3::jsonb) as revision',[id,revision,JSON.stringify(choices)])).rows[0]!.revision }
    }),
    check:(id,input) => query(async tx => {
      const prepared = prepareCommit(await draft(tx,id),input)
      const counts=(await tx.query<{answer:ImportCheck}>('select koi_check_import_phones($1) as answer',[[...new Set(prepared.rows.filter(row=>row.selected).map(row=>row.phone))]])).rows[0]!.answer
      const updates=(await tx.query<{updates:ImportCheck['updates']}>('select koi_import_update_preview($1,$2,$3) updates',[JSON.stringify(prepared.rows),JSON.stringify(prepared.choices.updateFields??[]),prepared.choices.product??null])).rows[0]!.updates
      return {...counts,updates}
    }),
    commit:(id,key,input) => query(async tx => {
      const payload = prepareCommit(await draft(tx,id),input)
      return (await tx.query<{ result:ImportResult }>('select koi_commit_import($1,$2,$3::jsonb) as result',[id,key,JSON.stringify(payload)])).rows[0]!.result
    }),
    contacts:(listId,page,phone) => query(async tx => ({
      leads:(await tx.query<Lead>(`select l.*,exists(select 1 from koi_suppressions s where s.workspace_id=l.workspace_id and s.phone=l.phone) as suppressed from koi_leads l join koi_lead_list_members m on m.lead_id=l.id where l.deleted_at is null and m.list_id=$1 and l.phone like $2 order by l.phone limit 50 offset $3`,[listId,`%${phone}%`,(page-1)*50])).rows,
      total:Number((await tx.query<{ n:number }>('select count(*) as n from koi_leads l join koi_lead_list_members m on m.lead_id=l.id where l.deleted_at is null and m.list_id=$1 and l.phone like $2',[listId,`%${phone}%`])).rows[0]!.n),
    })),
    report:id => query(async tx => { await draft(tx,id); return (await tx.query('select source_row,selected,outcome,prepared from koi_import_rows where import_id=$1 order by source_row',[id])).rows }),
  },
}
const server = createApp({
  statistics: async (request, url, actor) => {
    if (actor.membership.workspace_id !== workspace) throw new ApiError(403,'Sin permiso.')
    if (request.method !== 'GET') throw new ApiError(405,'Solo lectura en esta prueba.')
    const from = Date.parse(url.searchParams.get('from') ?? '')
    const to = Date.parse(url.searchParams.get('to') ?? '')
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new ApiError(422,'Período de prueba inválido.')
    const meta = { state:'ready', updatedAt:new Date().toISOString(), coverageFrom:'2026-01-01' }
    if (url.pathname === '/api/crm/stats/whatsapp') {
      const week = to - from <= 7 * 86_400_000
      const ads = [
        { id:'creative-a', name:'Video del estudio', spend:week ? 5000 : 10000, consultations:week ? 2 : 4 },
        { id:'creative-b', name:'Foto de producto', spend:5000, consultations:0 },
      ]
      const totals = { spend: ads[0]!.spend + ads[1]!.spend, consultations: ads[0]!.consultations }
      return { ...meta, groups:[{ ...totals, currency:'ARS', campaigns:[{ id:'campaign-mobiliario',name:'Mobiliario',...totals,ads }] }],
        unattributed:2, pendingCampaign:1, canConnect:true }
    }
    if (url.pathname === '/api/crm/stats/instagram') {
      return { ...meta, accountName:'Koi Estudio', reach:812, views:1203, interactions:0, followers:128, followersChange:-4,
        followerCoverage:{ from:'2026-11-01',to:'2026-11-16' } }
    }
    throw new ApiError(404,'Reporte de prueba desconocido.')
  },
  inboxRichEnabled:true,inboxSendEnabled:true,
  inboxMedia:async lookup=>{
    const samples=[
      ['image/png','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6iQAAAAASUVORK5CYII='],
      ['application/pdf',Buffer.from('%PDF-1.7 synthetic').toString('base64')],
      ['audio/wav','UklGRhQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YfAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA='],
      ['image/webp','UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'],
    ] as const
    const sample=samples[lookup.index]
    if(!sample)throw new ApiError(404,'Archivo de prueba inexistente.')
    return {mime:sample[0],name:lookup.name,base64:sample[1]}
  },
  readChatMedia: async ({providerId}) => {
    if (providerId!=='sticker-e2e') throw new ApiError(404,'Archivo de prueba no encontrado.')
    return 'UklGRkoAAABXRUJQVlA4ID4AAABQAwCdASoYABgAPm00lkekIyIhKAgAgA2JZQB2APwAAIMoIAD+7xUH//3eb9vN+3m/4aP//npmvMH9NAAAAA=='
  },
  webhook:createWebhook('synthetic-chat-hook-test-only','test-only',inbound,true), origin:'http://127.0.0.1:4179',authorize:async token => {
  if (!token.endsWith('.synthetic-koi')) throw new ApiError(401,'Token de prueba requerido.')
  return store
} })
server.listen(4180,'127.0.0.1')
process.on('SIGTERM',() => {clearInterval(sendTimer); server.closeAllConnections(); server.close(() => { void db.close().then(() => process.exit(0)) }) })
