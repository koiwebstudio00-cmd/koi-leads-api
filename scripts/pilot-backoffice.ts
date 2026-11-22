// Exercise the imported catalog on an in-memory restore. No remote connection is used.
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID,randomBytes,createHash } from 'node:crypto'
import { z } from 'zod'
import { manifestSQL,differences } from './reconcile-backoffice.ts'

const [dir,space,source]=process.argv.slice(2)
if(!dir||!source)throw Error('Uso: directorio-catalogo workspace origen')
const workspace=z.uuid().parse(space)
await readFile(join(dir,'PG_VERSION'),'utf8')
const catalog=new PGlite(dir)
const bindings=[workspace,source]
type Row={entity:string;key:string;digest:string}
const query=manifestSQL('target')
const snapshot=await (async()=>{
  try{
    const history=(await catalog.query<Row>(query,bindings)).rows
    assert.ok(history.length,'Catálogo histórico vacío')
    return {history,backup:await catalog.dumpDataDir()}
  }finally{await catalog.close()}
})()
const db=await PGlite.create({loadDataDir:snapshot.backup})
try{
  assert.deepEqual(differences(snapshot.history,(await db.query<Row>(query,bindings)).rows),[])
  const {rows:projects}=await db.query<{id:string;ownership:string}>('select distinct on (ownership) id,ownership from koi_private.studio_projects where workspace_id=$1 and source=$2 order by ownership,id',bindings)
  const project=(type:string)=>{const p=projects.find(p=>p.ownership===type);assert.ok(p,type);return p.id}
  const internal=project('studio'),custom=project('client'),saas=project('saas')
  const [{user_id:owner}]=(await db.query<{user_id:string}>('select user_id from koi_private.finance_owners where workspace_id=$1 and vault_access and portal_access limit 1',[workspace])).rows as [{user_id:string}]
  const operator=randomUUID()
  await db.query('insert into auth.users(id) values($1)',[operator])
  await db.query("insert into public.koi_workspace_members(workspace_id,user_id,role) values($1,$2,'operator')",[workspace,operator])
  async function command<T>(actor:string,module:'delivery'|'client'|'sensitive'|'finance',action:string,p:unknown={}):Promise<T>{
    return db.transaction(async tx=>{
      await tx.exec('set local role authenticated')
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor])
      return (await tx.query<{result:T}>(`select public.koi_${module}_command($1,$2) result`,[action,p])).rows[0]!.result
    })
  }
  assert.equal(await command(operator,'finance','access'),false)
  assert.deepEqual(await command(operator,'sensitive','access'),{vault:false,portal:false})
  assert.equal(await command(owner,'finance','access'),true)
  const customClients=await command<{id:string}[]>(operator,'client','projectClients',{projectId:custom})
  assert.ok(customClients.length)
  const task=async(projectId:string,clientId:string|null)=>command<{id:string}>(operator,'delivery','create',{
    projectId,clientId,kind:'task',key:randomUUID(),title:'Entrega del piloto',status:'done',body:'',projects:[]})
  await task(custom,customClients[0]!.id)
  await task(internal,null)
  const customers:string[]=[]
  for(let i=0;i<2;i++){
    const lead=(await db.query<{id:string}>('insert into public.koi_leads(workspace_id,name,phone,created_by) values($1,$2,$3,$4) returning id',[workspace,'Lead piloto '+i,'549110000000'+i,operator])).rows[0]!
    const {clientId}=await command<{clientId:string}>(operator,'client','convert',{leadId:lead.id,projectId:saas,name:'Cliente piloto '+i,key:randomUUID()})
    customers.push(clientId)
  }
  await task(saas,customers[0]!)
  const note=await command<{id:string}>(operator,'delivery','create',{projectId:saas,clientId:customers[0],kind:'note',status:'internal',title:'Entrega piloto',body:'Entrega publicada',key:randomUUID(),projects:[]})
  async function publish(clientId:string,withNote:boolean){
    const choices=[{kind:'project',id:saas}]
    if(withNote)choices.push({kind:'note',id:note.id})
    await command(owner,'sensitive','portal_publish',{clientId,revision:0,choices})
    const token=randomBytes(32).toString('base64url')
    await command(owner,'sensitive','portal_rotate',{clientId,revision:1,hash:createHash('sha256').update(token).digest('hex')})
    return db.transaction(async tx=>{
      await tx.exec('set local role anon')
      return (await tx.query<{portal:{items:{id:string;completed:number}[]}}>('select public.koi_read_client_portal($1,null) portal',[token])).rows[0]!.portal.items
    })
  }
  const first=await publish(customers[0]!,true),second=await publish(customers[1]!,false)
  assert.ok(first.some(i=>i.id===note.id))
  assert.ok(!second.some(i=>i.id===note.id))
  assert.equal(first.find(i=>i.id===saas)!.completed,second.find(i=>i.id===saas)!.completed+1)
  assert.deepEqual(differences(snapshot.history,(await db.query<Row>(query,bindings)).rows),[])
  // Prove that a correction with the same identity and row count still blocks the cut.
  await db.query("update koi_private.studio_projects set name=left(name,150)||' (piloto)' where id=$1 and workspace_id=$2",[custom,workspace])
  const delta=differences(snapshot.history,(await db.query<Row>(query,bindings)).rows)
  assert.equal(delta.length,1)
  assert.equal(delta[0]!.reason,'contenido_o_relacion')
  console.log({restoredHistoricalRows:snapshot.history.length,projectTypes:projects.map(p=>p.ownership),saasTestClients:customers.length,detectedChanges:delta.length})
}finally{await db.close()}
