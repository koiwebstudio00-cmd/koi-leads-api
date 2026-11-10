// Servidor exclusivo de pruebas: API/parser reales, PostgreSQL embebido y Auth sintética.
// Nunca se importa desde src/index.ts ni lee credenciales del entorno.
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
  chat:(action,data) => query(async tx => {
    try { return (await tx.query<{result:unknown}>('select koi_chat_command($1,$2) as result',[action,JSON.stringify(data)])).rows[0]!.result }
    catch (error) { chatError(error as {code?:string;message?:string}) }
  }),
  crm:(action,data) => query(async tx => {
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
const server = createApp({ webhook:createWebhook('synthetic-chat-hook-test-only','test-only',inbound,true), origin:'http://127.0.0.1:4179',authorize:async token => {
  if (!token.endsWith('.synthetic-koi')) throw new ApiError(401,'Token de prueba requerido.')
  return store
} })
server.listen(4180,'127.0.0.1')
process.on('SIGTERM',() => { server.closeAllConnections(); server.close(() => { void db.close().then(() => process.exit(0)) }) })
