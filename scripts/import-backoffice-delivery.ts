import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { prepare,type Snapshot } from './backoffice-stage.ts'

const kinds={tasks:'task',milestones:'milestone',notes:'note',meetings:'meeting',feature_requests:'improvement'} as const
const tables=[...Object.keys(kinds),'feature_request_comments','meeting_projects']
type Target={query:(sql:string,params:unknown[])=>Promise<{rows:unknown[]}>}

// Call inside a target transaction after staging metadata and validating parent IDs.
export async function importDelivery(stage:PGlite,target:Target,source:string,workspace:string,snapshot:Snapshot){
  const staged=await stage.query<{entity:string;source_key:string;target_id:string}>('select entity,source_key,target_id from staging where workspace=$1 and source=$2',[workspace,source])
  const ids=new Map(staged.rows.map(row=>[row.entity+'/'+row.source_key,row.target_id]))
  function id(table:string,key:unknown){
    const result=ids.get(table+'/'+z.uuid().parse(key))
    if(!result)throw Error('Falta una identidad en staging de '+table)
    return result
  }
  let reviewed=0,inserted=0
  for(const [table,kind] of Object.entries(kinds)){
    for(const row of snapshot[table]??[]){
      reviewed++
      const title=kind==='note'?'Nota':row.title
      const body=kind==='note'?row.body:kind==='meeting'?row.notes:row.description
      const status=kind==='note'?'internal':kind==='meeting'?'scheduled':kind==='milestone'?(row.done?'done':'todo'):row.status
      const result=await target.query(`insert into koi_private.delivery_items
        (workspace_id,id,kind,title,body,status,due_date,starts_at,ends_at,location,project_id,client_id,position,author,source,source_id,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        on conflict(workspace_id,source,kind,source_id) do nothing returning id`,
        [workspace,id(table,row.id),kind,title,body??'',status,row.due_date??null,row.starts_at??null,row.ends_at??null,row.location??null,
          row.project_id?id('projects',row.project_id):null,row.client_id?id('clients',row.client_id):null,row.position??0,row.created_by,source,row.id,row.created_at,row.updated_at])
      inserted+=result.rows.length
      if(!result.rows.length && !(await target.query('select id from koi_private.delivery_items where workspace_id=$1 and source=$2 and kind=$3 and source_id=$4 and id=$5',[workspace,source,kind,row.id,id(table,row.id)])).rows.length)
        throw Error('Conflicto de identidad en '+table)
    }
  }
  // Some clients predate the notes table. Keep the memo internal and its provenance distinct.
  for(const row of snapshot.client_memos??[]){
    reviewed++
    const clientId=id('clients',row.id)
    const result=await target.query(`insert into koi_private.delivery_items
      (workspace_id,id,kind,title,body,status,client_id,author,source,source_id,created_at,updated_at)
      values($1,$2,'note','Nota histórica del cliente',$3,'internal',$2,$4,$5,$6,$7,$8)
      on conflict(workspace_id,source,kind,source_id) do nothing returning id`,
      [workspace,clientId,row.notes,row.created_by,source+':clients.notes',row.id,row.created_at,row.updated_at])
    inserted+=result.rows.length
  }
  for(const row of snapshot.feature_request_comments??[]){
    reviewed++
    inserted+=(await target.query(`insert into koi_private.delivery_comments(workspace_id,id,item_id,body,author,created_at)
      values($1,$2,$3,$4,$5,$6) on conflict do nothing returning id`,
      [workspace,id('feature_request_comments',row.id),id('feature_requests',row.feature_request_id),row.body,row.created_by,row.created_at])).rows.length
  }
  for(const row of snapshot.meeting_projects??[]){
    reviewed++
    inserted+=(await target.query(`insert into koi_private.delivery_meeting_projects(workspace_id,item_id,project_id)
      select workspace_id,id,$3 from koi_private.delivery_items where workspace_id=$1 and id=$2 and revision=0
      on conflict do nothing returning item_id`,
      [workspace,id('meetings',row.meeting_id),id('projects',row.project_id)])).rows.length
  }
  return {reviewed,inserted,existing:reviewed-inserted}
}

async function main(){
  const [workspace,mode]=process.argv.slice(2)
  const {BACKOFFICE_STAGE_DIR:dir,BACKOFFICE_SOURCE_ID:source,BACKOFFICE_SOURCE_DATABASE_URL:origin,KOI_PROJECT_DATABASE_URL:destination}=process.env
  if(!workspace||!dir||!source||!origin||!destination||!['preview','apply'].includes(mode??''))throw Error('Configurar origen, staging y destino. Uso: workspace preview|apply')
  const reader=new pg.Client({connectionString:origin}),target=new pg.Client({connectionString:destination}),stage=new PGlite(dir)
  try{
    await reader.connect()
    await reader.query('begin isolation level repeatable read read only')
    await reader.query('set local row_security=off')
    const snapshot:Snapshot={}
    for(const name of tables)snapshot[name]=(await reader.query('select * from public.'+name)).rows
    snapshot.client_memos=(await reader.query("select id,notes,created_by,created_at::text,updated_at::text from public.clients where nullif(trim(notes),'') is not null")).rows
    await reader.query('commit')
    const report=await prepare(stage,source,workspace,snapshot,true)
    if(report.conflicts.length)throw Error(report.conflicts.join('\n'))
    await target.connect()
    await target.query('begin')
    const imported=await importDelivery(stage,target,source,workspace,snapshot)
    await target.query(mode==='apply'?'commit':'rollback')
    console.log({mode,...imported})
  }finally{await reader.end();await target.end();await stage.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(err=>{console.error(err.message);process.exitCode=1})
