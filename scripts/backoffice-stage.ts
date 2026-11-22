import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { z } from 'zod'

type Definition = { module: string; columns: string; parents?: Record<string,string>; key?: string[] }
// Staging holds identities and relationships. Vault material, portal tokens and free text stay at source.
export const tables: Record<string,Definition> = {
  profiles: { module:'team', columns:'id role created_at updated_at' },
  clients: { module:'clients', columns:'id name company email phone status created_by created_at updated_at' },
  projects: { module:'projects', columns:'id name type status start_date deadline client_id created_by created_at updated_at', parents:{client_id:'clients'} },
  tasks: { module:'delivery', columns:'id status project_id created_by created_at updated_at', parents:{project_id:'projects'} },
  milestones: { module:'delivery', columns:'id done project_id created_by created_at updated_at', parents:{project_id:'projects'} },
  notes: { module:'delivery', columns:'id client_id project_id created_by created_at updated_at', parents:{client_id:'clients',project_id:'projects'} },
  meetings: { module:'delivery', columns:'id created_by created_at updated_at' },
  meeting_projects: {module:'delivery', columns:'meeting_id project_id', key:['meeting_id','project_id'], parents:{meeting_id:'meetings',project_id:'projects'}},
  feature_requests: {module:'improvements',columns:'id status created_by created_at updated_at'},
  feature_request_comments: {module:'improvements',columns:'id feature_request_id created_by created_at', parents:{feature_request_id:'feature_requests'}},
  project_financials: {module:'finance',columns:'project_id currency created_at updated_at',key:['project_id'],parents:{project_id:'projects'}},
  financial_movements: {module:'finance',columns:'id type status currency payment_method recurrence series_id client_id project_id created_at created_by updated_at',parents:{client_id:'clients',project_id:'projects'}},
  credentials: {module:'vault',columns:'id key_version client_id project_id created_by created_at updated_at',parents:{client_id:'clients',project_id:'projects'}},
  credential_access_log: {module:'vault',columns:'id credential_id user_id accessed_at',parents:{credential_id:'credentials'}},
  project_env_files: {module:'vault',columns:'id key_version project_id created_by created_at updated_at',parents:{project_id:'projects'}},
  env_file_access_log: {module:'vault',columns:'id env_file_id user_id accessed_at',parents:{env_file_id:'project_env_files'}},
  client_portal_tokens: {module:'portal',columns:'id client_id created_by created_at revoked_at last_accessed_at',parents:{client_id:'clients'}},
}
type Row = Record<string, unknown>
export type Snapshot = Record<string, Row[]>

export async function prepare(db:PGlite, source:string, workspace:string, snapshot:Snapshot, apply:boolean) {
  z.uuid().parse(workspace)
  if (!source.trim()) throw Error('Falta identificar el origen.')
  await db.exec('create table if not exists staging (source text, workspace uuid, entity text, source_key text, target_id uuid not null unique, metadata jsonb not null, primary key(source,workspace,entity,source_key))')
  const counts:Record<string,number> = {}
  const conflicts:string[] = []
  const keys = new Map<string,Set<string>>()
  const records: {table:string; id:string; target:string; metadata:Row; parents?:Record<string,string>}[] = []
  for (const [table,def] of Object.entries(tables)) {
    if (!Object.hasOwn(snapshot,table)) continue
    const seen = new Set<string>()
    keys.set(table,seen)
    counts[table] = snapshot[table]!.length
    for (const row of snapshot[table]!) {
      const id = (def.key ?? ['id']).map(k=>z.uuid().parse(row[k])).join('/')
      if (seen.has(id)) conflicts.push(table+'/'+id+' duplicado')
      seen.add(id)
      const metadata = Object.fromEntries(def.columns.split(' ').map(k=>[k,row[k]]))
      // Stable UUID scoped to the source instance, tenant and original key.
      const hash = createHash('sha256').update(JSON.stringify([source,workspace,table,id])).digest()
      hash[6] = (hash[6]! & 15) | 128
      hash[8] = (hash[8]! & 63) | 128
      const hex = hash.toString('hex')
      const target = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20,32)].join('-')
      records.push({table,id,target,metadata,parents:def.parents})
    }
  }
  await db.transaction(async tx=>{
    for (const rec of records) {
      for (const [field,parent] of Object.entries(rec.parents ?? {})) {
        const ref = rec.metadata[field]
        if (ref == null || keys.get(parent)?.has(String(ref))) continue
        if (!keys.has(parent)) {
          const existing = await tx.query('select 1 from staging where source=$1 and workspace=$2 and entity=$3 and source_key=$4',[source,workspace,parent,ref])
          if (existing.rows.length) continue
        }
        conflicts.push(rec.table+'/'+rec.id+' sin referencia '+field)
      }
    }
    if (!apply || conflicts.length) return
    for (const rec of records) await tx.query(
      'insert into staging values ($1,$2,$3,$4,$5,$6) on conflict(source,workspace,entity,source_key) do update set metadata=excluded.metadata where staging.metadata is distinct from excluded.metadata',
      [source,workspace,rec.table,rec.id,rec.target,JSON.stringify(rec.metadata)])
  })
  return {counts,conflicts,applied:apply && !conflicts.length}
}

type Contact = { id:string; email:string|null; phone:string|null }
export function reconcile(clients:Contact[], leads:Contact[]) {
  const index = new Map<string,Set<string>>()
  function signals(contact:Contact) {
    const email = contact.email?.trim().toLowerCase()
    const phone = contact.phone?.trim().replace(/[ ().-]/g,'').replace(/^\+/, '')
    return [email && 'email:'+email, phone && /^[1-9][0-9]{9,14}$/.test(phone) && 'phone:'+phone].filter((v):v is string=>Boolean(v))
  }
  for (const lead of leads) for (const key of signals(lead)) {
    const ids = index.get(key) ?? new Set<string>()
    ids.add(lead.id)
    index.set(key,ids)
  }
  return clients.map(client=>{
    const ids = new Set(signals(client).flatMap(key=>[...(index.get(key) ?? [])]))
    return {clientId:client.id, candidates:[...ids].sort(), status:ids.size>1?'ambiguous':ids.size?'requires_verification':'unmatched'}
  })
}

async function main() {
  const [workspace,mode,module='all'] = process.argv.slice(2)
  z.uuid().parse(workspace)
  if (!['preview','stage'].includes(mode??'') || (module!=='all' && !Object.values(tables).some(t=>t.module===module))) throw Error('Uso: workspace preview|stage [módulo]')
  const connectionString = process.env.BACKOFFICE_SOURCE_DATABASE_URL
  if (!connectionString) throw Error('Falta BACKOFFICE_SOURCE_DATABASE_URL')
  const source = process.env.BACKOFFICE_SOURCE_ID
  if (!source) throw Error('Falta BACKOFFICE_SOURCE_ID')
  const dir = process.env.BACKOFFICE_STAGE_DIR
  if (mode==='stage' && !dir) throw Error('Falta BACKOFFICE_STAGE_DIR')
  const client = new pg.Client({connectionString})
  await client.connect()
  try {
    await client.query('begin isolation level repeatable read read only')
    // An RLS-filtered export could mistake invisible records for an empty module.
    await client.query('set local row_security = off')
    const snapshot:Snapshot = {}
    for (const [table,def] of Object.entries(tables)) {
      if (module!=='all' && def.module!==module) continue
      // Postgres DATE values are calendar dates. Keep them independent of the host timezone.
      const columns=def.columns.split(' ').map(column=>
        table==='projects' && ['start_date','deadline'].includes(column) ? column+'::text as '+column : column)
      snapshot[table]=(await client.query('select '+columns.join(',')+' from public.'+table)).rows
    }
    let candidates
    const targetUrl = process.env.KOI_RECONCILE_DATABASE_URL
    if (targetUrl && snapshot.clients) {
      const clients = await client.query<Contact>('select id,email,phone from public.clients')
      const target = new pg.Client({connectionString:targetUrl})
      await target.connect()
      try {
        await target.query('begin read only')
        await target.query('set local row_security = off')
        const exists = await target.query('select id from public.koi_workspaces where id=$1',[workspace])
        if (!exists.rowCount) throw Error('Espacio de destino inexistente.')
        const leads = await target.query<Contact>('select id,email,phone from public.koi_leads where workspace_id=$1 and deleted_at is null',[workspace])
        candidates = reconcile(clients.rows,leads.rows)
        await target.query('commit')
      } finally { await target.end() }
    }
    await client.query('commit')
    if (dir) {
      await mkdir(dir,{recursive:true,mode:0o700})
      if ((await stat(dir)).mode & 0o077) throw Error('El directorio local debe ser privado (0700).')
    }
    const db = new PGlite(dir)
    try {
      const report = await prepare(db,source,workspace!,snapshot,mode==='stage')
      console.log(JSON.stringify({...report,contactReview:candidates},null,2))
      if (report.conflicts.length) process.exitCode=1
    } finally { await db.close() }
  } finally { await client.end() }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1})
}
