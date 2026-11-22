import { PGlite } from '@electric-sql/pglite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { z } from 'zod'

const legacyProject=z.object({
  id:z.uuid(),name:z.string().min(1).max(160),type:z.string().min(1).max(80),
  status:z.enum(['active','paused','done']),start_date:z.iso.date().nullable(),deadline:z.iso.date().nullable(),
  client_id:z.uuid().nullable(),created_by:z.uuid(),created_at:z.string(),updated_at:z.string(),
})
type Target={query:(sql:string,params:unknown[])=>Promise<{rows:unknown[]}>}

// Run inside one target transaction. A repeated import preserves subsequent catalog edits.
export async function importCatalog(stage:PGlite,target:Target,source:string,workspace:string) {
  z.uuid().parse(workspace)
  const records=await stage.query<{target_id:string; metadata:unknown; client_label:string|null}>(
    `select p.target_id,p.metadata,coalesce(nullif(trim(c.metadata->>'company'),''),c.metadata->>'name') as client_label
     from staging p left join staging c on c.workspace=p.workspace and c.source=p.source and c.entity='clients' and c.source_key=p.metadata->>'client_id'
     where p.workspace=$1 and p.source=$2 and p.entity='projects' order by p.source_key`,[workspace,source])
  if (!records.rows.length) throw Error('El staging elegido no contiene proyectos.')
  let inserted=0
  for (const row of records.rows) {
    const p=legacyProject.parse(row.metadata)
    const ownership=p.client_id?'client':/\bsaas\b/i.test(p.type)?'saas':'studio'
    const values=[workspace,row.target_id,p.name,p.type,ownership,p.status,p.start_date,p.deadline,source,p.id,p.client_id,p.created_by,p.created_at,p.updated_at,row.client_label]
    const result=await target.query(`insert into koi_private.studio_projects
      (workspace_id,id,name,type,ownership,status,start_date,deadline,source,source_project_id,source_client_id,source_author_id,created_at,updated_at,source_client_label)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      on conflict(workspace_id,source,source_project_id) do nothing returning id`,values)
    inserted+=result.rows.length
    if(!result.rows.length) {
      const known=await target.query('select id from koi_private.studio_projects where workspace_id=$1 and source=$2 and source_project_id=$3 and id=$4',[workspace,source,p.id,row.target_id])
      if(!known.rows.length)throw Error('Conflicto de identidad para el proyecto '+p.id)
    }
  }
  return {reviewed:records.rows.length,inserted,existing:records.rows.length-inserted}
}

export async function importClients(stage:PGlite,target:Target,source:string,workspace:string) {
  const records=await stage.query<{target_id:string;metadata:unknown}>(
    "select target_id,metadata from staging where workspace=$1 and source=$2 and entity='clients' order by source_key",[workspace,source])
  if(!records.rows.length)throw Error('El staging elegido no contiene clientes.')
  let inserted=0
  for(const row of records.rows){
    const c=z.object({id:z.uuid(),name:z.string().min(1),company:z.string().nullable(),email:z.string().nullable(),phone:z.string().nullable(),
      status:z.enum(['lead','active','paused','closed']),created_by:z.uuid(),created_at:z.string()}).parse(row.metadata)
    const result=await target.query(`insert into koi_private.clients(workspace_id,id,name,contact_name,email,phone,status,source,source_id,source_author,created_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(workspace_id,source,source_id) do nothing returning id`,
      [workspace,row.target_id,c.company?.trim()||c.name,c.name,c.email,c.phone,c.status,source,c.id,c.created_by,c.created_at])
    inserted+=result.rows.length
    if(!result.rows.length && !(await target.query('select id from koi_private.clients where workspace_id=$1 and id=$2 and source=$3 and source_id=$4',[workspace,row.target_id,source,c.id])).rows.length)
      throw Error('Conflicto de identidad del cliente '+c.id)
  }
  const missing=await target.query(`select s.id from koi_private.studio_projects s left join koi_private.clients c
    on c.workspace_id=s.workspace_id and c.source=s.source and c.source_id=s.source_client_id
    where s.workspace_id=$1 and s.source=$2 and s.source_client_id is not null and c.id is null`,[workspace,source])
  if(missing.rows.length)throw Error('Hay proyectos con clientes de origen sin resolver.')
  const links=await target.query(`insert into koi_private.client_projects(workspace_id,client_id,project_id,created_at)
    select s.workspace_id,c.id,s.id,s.created_at from koi_private.studio_projects s join koi_private.clients c
    on c.workspace_id=s.workspace_id and c.source=s.source and c.source_id=s.source_client_id where s.workspace_id=$1 and s.source=$2
    on conflict do nothing returning project_id`,[workspace,source])
  return {reviewed:records.rows.length,inserted,existing:records.rows.length-inserted,linked:links.rows.length}
}

async function main(){
  const [workspace,mode,module='projects']=process.argv.slice(2)
  const {BACKOFFICE_STAGE_DIR:dir,BACKOFFICE_SOURCE_ID:source,KOI_PROJECT_DATABASE_URL:url}=process.env
  if(!['projects','clients'].includes(module)||!workspace||!dir||!source||!url||!['preview','apply'].includes(mode??''))throw Error('Configurar origen, staging y destino. Uso: workspace preview|apply')
  const target=new pg.Client({connectionString:url})
  const stage=new PGlite(dir)
  try {
    await target.connect()
    await target.query('begin')
    const report=await (module==='clients'?importClients:importCatalog)(stage,target,source,workspace)
    await target.query(mode==='apply'?'commit':'rollback')
    console.log({mode,...report})
  }finally{await target.end();await stage.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1})
