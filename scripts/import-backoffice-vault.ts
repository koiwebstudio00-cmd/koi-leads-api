import { createDecipheriv } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { vaultContent } from '../src/sensitive.ts'
import { prepare,type Snapshot } from './backoffice-stage.ts'
import { readVaultKeys,seal,unseal,type VaultKeys } from '../src/vault-crypto.ts'

type Target={query:(sql:string,params:unknown[])=>Promise<{rows:unknown[]}>}
type Stored={version:number;envelope:string;revision:number;source_key_version:number}
const entities=['credentials','project_env_files','credential_access_log','env_file_access_log'] as const

function decryptLegacy(key:Buffer|undefined,data:unknown,iv:unknown){
  if(!key||typeof data!=='string'||typeof iv!=='string')throw Error('Falta material para recuperar el origen.')
  const bytes=Buffer.from(data,'base64')
  const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'))
  cipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([cipher.update(bytes.subarray(0,-16)),cipher.final()]).toString('utf8')
}

// The caller controls the transaction. The recovery keys are supplied independently.
export async function importVault(stage:PGlite,db:Target,source:string,workspace:string,snapshot:Snapshot,legacy:VaultKeys,destination:VaultKeys,recovery:VaultKeys){
  const {rows}=await stage.query<{entity:string;source_key:string;target_id:string}>('select entity,source_key,target_id from staging where workspace=$1 and source=$2',[workspace,source])
  const mapping=new Map(rows.map(r=>[r.entity+'/'+r.source_key,r.target_id]))
  function id(table:string,key:unknown){
    const result=mapping.get(table+'/'+String(key))
    if(!result)throw Error('Referencia histórica sin conciliar.')
    return result
  }
  let verified=0,inserted=0,accesses=0
  for(const table of entities){
    for(const r of snapshot[table]!){
      if(table==='credential_access_log'||table==='env_file_access_log'){
        const parent=table==='credential_access_log'?id('credentials',r.credential_id):id('project_env_files',r.env_file_id)
        const result=await db.query('insert into koi_private.vault_accesses(workspace_id,id,entry_id,actor,accessed_at) values($1,$2,$3,$4,$5) on conflict(workspace_id,id) do nothing returning id',[workspace,id(table,r.id),parent,r.user_id,r.accessed_at])
        accesses+=result.rows.length
        continue
      }
      const credential=table==='credentials',kind=credential?'credential':'env',binding={workspace,id:id(table,r.id),kind}
      const key=legacy.keys.get(Number(r.key_version))
      const decrypt=(field:string)=>decryptLegacy(key,r[field+'_ciphertext'],r[field+'_iv'])
      const content=JSON.stringify(vaultContent.parse({value:decrypt(credential?'secret':'content'),username:r.username??'',url:r.service_url??'',notes:r.notes_ciphertext==null&&r.notes_iv==null?'':decrypt('notes')}))
      const wrapped=seal(destination,binding,content)
      if(unseal(recovery,binding,wrapped.version,wrapped.envelope)!==content)throw Error('Falló la recuperación.')
      const result=await db.query(`insert into koi_private.vault_entries(workspace_id,id,kind,label,project_id,client_id,author,created_at,updated_at,version,envelope,source,source_id,source_key_version)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(workspace_id,source,kind,source_id) do nothing returning id`,[workspace,binding.id,kind,credential?r.service_name:r.name,r.project_id?id('projects',r.project_id):null,r.client_id?id('clients',r.client_id):null,r.created_by,r.created_at,r.updated_at,wrapped.version,wrapped.envelope,source,r.id,r.key_version])
      inserted+=result.rows.length
      const stored=(await db.query('select version,envelope,revision,source_key_version from koi_private.vault_entries where workspace_id=$1 and id=$2 for update',[workspace,binding.id])).rows[0] as Stored
      const recovered=unseal(recovery,binding,stored.version,stored.envelope)
      if(!stored.revision&&recovered!==content)throw Error('Diferencia con el registro histórico.')
      verified++
    }
  }
  return {verified,inserted,accesses}
}
async function main(){
  const [workspace,mode]=process.argv.slice(2),env=process.env
  const source=env.BACKOFFICE_SOURCE_ID,dir=env.BACKOFFICE_STAGE_DIR
  const legacy=readVaultKeys(env.BACKOFFICE_VAULT_KEYS??(env.MASTER_ENCRYPTION_KEY&&JSON.stringify({1:env.MASTER_ENCRYPTION_KEY})),env.BACKOFFICE_VAULT_ACTIVE_VERSION??'1')
  const destination=readVaultKeys(env.KOI_VAULT_KEYS,env.KOI_VAULT_KEY_VERSION),recovery=readVaultKeys(env.KOI_VAULT_RECOVERY_KEYS,env.KOI_VAULT_KEY_VERSION)
  if(!workspace||!source||!dir||!env.BACKOFFICE_SOURCE_DATABASE_URL||!env.KOI_PROJECT_DATABASE_URL||!legacy||!destination||!recovery||!['preview','apply'].includes(mode??''))throw Error('Configuración incompleta.')
  const reader=new pg.Client({connectionString:env.BACKOFFICE_SOURCE_DATABASE_URL}),writer=new pg.Client({connectionString:env.KOI_PROJECT_DATABASE_URL}),stage=new PGlite(dir)
  try{
    await reader.connect()
    await reader.query('begin isolation level repeatable read read only')
    await reader.query('set local row_security=off')
    const snapshot:Snapshot={}
    for(const table of entities)snapshot[table]=(await reader.query('select * from public.'+table)).rows
    await reader.query('commit')
    if((await prepare(stage,source,workspace,snapshot,true)).conflicts.length)throw Error('Referencias incompletas.')
    await writer.connect()
    await writer.query('begin')
    const report=await importVault(stage,writer,source,workspace,snapshot,legacy,destination,recovery)
    await writer.query(mode==='apply'?'commit':'rollback')
    console.log({mode,...report})
  }finally{await Promise.allSettled([reader.end(),writer.end(),stage.close()])}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Importación cancelada. Verificá las llaves, las conexiones y la conciliación del catálogo.');process.exitCode=1})
