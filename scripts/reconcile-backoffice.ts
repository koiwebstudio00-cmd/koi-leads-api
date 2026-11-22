// A manifest contains historical identities and fingerprints, never note bodies or secrets.
// Both databases hash the same normalized projection; counts alone cannot detect swapped links.
import pg from 'pg'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

type Projection={entity:string;key:string;fields:string;from:string}
type Side='source'|'target'
type Fingerprint={entity:string;key:string;digest:string}

function projected(side:Side):Projection[]{
  const source=side==='source'
  const rows:Projection[]=[]
  function add(entity:string,key:string,fields:string,from:string){
    rows.push({entity,key,fields,from})
  }
  const privateTable=(name:string)=>'koi_private.'+name+' r'
  const scoped="r.workspace_id=$1 and r.source=$2"
  const clients=" left join koi_private.clients c on c.workspace_id=r.workspace_id and c.id=r.client_id"
  const projects=" left join koi_private.studio_projects p on p.workspace_id=r.workspace_id and p.id=r.project_id"
  const project="coalesce(p.source_project_id,r.project_id)",client="coalesce(c.source_id,r.client_id)"
  const table=(name:string,dest:string,joins='')=>source?'public.'+name+' r':privateTable(dest)+joins+' where '+scoped
  add('clients',source?'r.id':'r.source_id',source?"coalesce(nullif(trim(r.company),''),r.name),r.name,r.status,r.phone,r.email,r.created_by":"r.name,r.contact_name,r.status,r.phone,r.email,r.source_author",table('clients','clients'))
  add('projects',source?'r.id':'r.source_project_id','r.name,r.type,r.status,r.start_date,r.deadline,'+(source?"r.client_id,r.created_by,case when r.client_id is not null then 'client' when r.type ~* '\\msaas\\M' then 'saas' else 'studio' end":"r.source_client_id,r.source_author_id,r.ownership"),table('projects','studio_projects'))
  add('contracts',source?'r.id':'p.source_project_id',source?'r.client_id':client,source?'public.projects r where r.client_id is not null':privateTable('client_projects')+clients+projects+' where r.workspace_id=$1 and p.source=$2 and r.actor is null')
  const delivery=[
    ['tasks','task','r.title,r.status,r.due_date,r.position,r.project_id','r.title,r.status,r.due_date,r.position,'+project],
    ['milestones','milestone',"r.title,case when r.done then 'done' else 'todo' end,r.due_date,r.position,r.project_id",'r.title,r.status,r.due_date,r.position,'+project],
    ['notes','note','r.body,r.client_id,r.project_id','r.body,'+client+','+project],
    ['meetings','meeting',"r.title,coalesce(r.notes,''),r.starts_at,r.ends_at,r.location",'r.title,r.body,r.starts_at,r.ends_at,r.location'],
    ['feature_requests','improvement',"r.title,coalesce(r.description,''),r.status",'r.title,r.body,r.status'],
  ] as const
  for(const [name,kind,left,right] of delivery){
    add(name,source?'r.id':'r.source_id',(source?left+',r.created_by':right+',r.author'),
      table(name,'delivery_items',clients+projects)+(source?'':" and r.kind='"+kind+"'"))
  }
  add('client_memos',source?'r.id':'r.source_id',source?'r.id,r.notes,r.created_by':client+',r.body,r.author',
    source?"public.clients r where nullif(trim(r.notes),'') is not null":privateTable('delivery_items')+clients+" where r.workspace_id=$1 and r.source=$2||':clients.notes' and r.kind='note'")
  add('meeting_projects',source?'r.meeting_id':'i.source_id',source?'r.project_id':project,source?'public.meeting_projects r':privateTable('delivery_meeting_projects')+projects+' join koi_private.delivery_items i on i.workspace_id=r.workspace_id and i.id=r.item_id where r.workspace_id=$1 and i.source=$2')
  add('feature_request_comments',source?'r.feature_request_id':'i.source_id',source?'r.body,r.created_by,r.created_at':'r.body,r.author,r.created_at',source?'public.feature_request_comments r':privateTable('delivery_comments')+' join koi_private.delivery_items i on i.workspace_id=r.workspace_id and i.id=r.item_id where r.workspace_id=$1 and i.source=$2')
  add('project_financials',source?'r.project_id':'r.source_id',(source?'r.project_id,trim_scale(r.budget)':project+',trim_scale(r.amount)')+',r.currency',table('project_financials','finance_budgets',projects))
  add('financial_movements',source?'r.id':'r.source_id','r.type,r.status,r.concept,r.category,trim_scale(r.amount),r.currency,r.payment_method,r.occurred_on,r.due_date,r.settled_on,r.notes,r.recurrence,r.series_id,'+(source?'r.project_id,r.client_id,r.created_by':project+','+client+',r.author'),table('financial_movements','finance_movements',clients+projects))
  return rows
}

export function manifestSQL(side:Side){
  const parts=projected(side).map(p=>`select '${p.entity}' entity,(${p.key})::text key,
    encode(sha256(convert_to(jsonb_build_array(${p.fields})::text,'UTF8')),'hex') digest from ${p.from}`)
  return parts.join('\nunion all\n')+' order by entity,key,digest'
}

// Keep multiplicity for meetings and comments sharing a parent key.
export function differences(source:Fingerprint[],target:Fingerprint[]){
  function index(rows:Fingerprint[]){
    const map=new Map<string,string[]>()
    for(const row of rows){
      const key=row.entity+'/'+row.key
      const hashes=map.get(key)??[]
      hashes.push(row.digest)
      map.set(key,hashes)
    }
    return map
  }
  const a=index(source),b=index(target)
  return [...new Set([...a.keys(),...b.keys()])].flatMap(key=>{
    const left=a.get(key),right=b.get(key)
    if(!left)return [{key,reason:'solo_destino'}]
    if(!right)return [{key,reason:'solo_origen'}]
    return left.sort().join()===right.sort().join()?[]:[{key,reason:'contenido_o_relacion'}]
  })
}

async function main(){
  const workspace=z.uuid().parse(process.argv[2])
  const {BACKOFFICE_SOURCE_ID:source,BACKOFFICE_SOURCE_DATABASE_URL:origin,KOI_PROJECT_DATABASE_URL:destination}=process.env
  if(!source||!origin||!destination)throw Error('Faltan conexiones o el identificador de origen.')
  const a=new pg.Client({connectionString:origin}),b=new pg.Client({connectionString:destination})
  try{
    for(const client of [a,b]){
      await client.connect()
      await client.query('begin isolation level repeatable read read only')
      await client.query("set local time zone 'UTC'")
      await client.query('set local row_security=off')
    }
    const workspaceRows=await b.query('select id from public.koi_workspaces where id=$1',[workspace])
    if(!workspaceRows.rowCount)throw Error('Espacio desconocido.')
    const left=await a.query<Fingerprint>(manifestSQL('source')),right=await b.query<Fingerprint>(manifestSQL('target'),[workspace,source])
    const delta=differences(left.rows,right.rows)
    if(!left.rowCount||!right.rowCount)throw Error('Catálogo vacío o identificador de origen incorrecto.')
    console.log(JSON.stringify({capturedAt:(await a.query('select transaction_timestamp()::text as utc')).rows[0].utc,sourceRows:left.rowCount,targetRows:right.rowCount,delta},null,2))
    if(delta.length)process.exitCode=2
  }finally{await Promise.allSettled([a.end(),b.end()])}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('No se pudo verificar la conciliación. Revisá conexiones, permisos y esquema.');process.exitCode=1})
