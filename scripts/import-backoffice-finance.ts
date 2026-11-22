import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { prepare,type Snapshot } from './backoffice-stage.ts'

type Target={query:(sql:string,params:unknown[])=>Promise<{rows:unknown[]}>}
type Totals={kind:string;currency:string;status:string;count:number;amount:string}
type Owner={id:string;identity:string|null}
export async function bindFinanceOwners(db:Target,source:string,workspace:string,owners:Owner[],members:Owner[]){
  const pairs=owners.map(owner=>{
    const matches=members.filter(m=>owner.identity && m.identity===owner.identity)
    if(matches.length!==1)throw Error('Falta verificar la identidad única de un owner en el destino.')
    return {origin:owner.id,destination:matches[0]!.id}
  })
  await db.query('delete from koi_private.finance_owners where workspace_id=$1 and source=$2 and not (user_id=any($3::uuid[]))',[workspace,source,pairs.map(p=>p.destination)])
  for(const pair of pairs){
    const saved=await db.query('insert into koi_private.finance_owners(workspace_id,user_id,source,source_owner_id) values($1,$2,$3,$4) on conflict(workspace_id,user_id) do update set source_owner_id=excluded.source_owner_id where finance_owners.source=excluded.source returning user_id',[workspace,pair.destination,source,pair.origin])
    if(!saved.rows.length)throw Error('El permiso existente pertenece a otro origen.')
  }
  return pairs.length
}

// The caller owns the transaction. Import historical installments before filling gaps.
export async function importFinance(stage:PGlite,db:Target,source:string,workspace:string,snapshot:Snapshot){
  const stageRows=await stage.query<{entity:string;source_key:string;target_id:string}>('select entity,source_key,target_id from staging where workspace=$1 and source=$2',[workspace,source])
  const ids=new Map(stageRows.rows.map(row=>[row.entity+'/'+row.source_key,row.target_id]))
  function id(table:string,key:unknown){
    const result=ids.get(table+'/'+String(key));if(!result)throw Error('Falta referencia en staging para '+table)
    return result
  }
  const movements=snapshot.financial_movements!,budgets=snapshot.project_financials!
  let inserted=0
  const seeds:string[]=[]
  for(const b of budgets){
    const result=await db.query(`insert into koi_private.finance_budgets(workspace_id,project_id,amount,currency,source,source_id,created_at,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(workspace_id,source,source_id) do nothing returning project_id`,
      [workspace,id('projects',b.project_id),b.budget,b.currency,source,b.project_id,b.created_at,b.updated_at])
    inserted+=result.rows.length
  }
  for(const m of movements){
    const mid=id('financial_movements',m.id)
    const result=await db.query(`insert into koi_private.finance_movements(workspace_id,id,type,status,concept,category,amount,currency,payment_method,occurred_on,due_date,settled_on,notes,
      client_id,project_id,recurrence,series_id,author,source,source_id,created_at,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      on conflict(workspace_id,source,source_id) do nothing returning id`,
      [workspace,mid,m.type,m.status,m.concept,m.category,m.amount,m.currency,m.payment_method,m.occurred_on,m.due_date,m.settled_on,m.notes,m.client_id?id('clients',m.client_id):null,
       m.project_id?id('projects',m.project_id):null,m.recurrence,m.series_id,m.created_by,source,m.id,m.created_at,m.updated_at])
    inserted+=result.rows.length
    if(result.rows.length && m.recurrence==='monthly'&&m.series_id&&(m.status==='settled'||m.series_id===m.id))seeds.push(mid)
  }
  for(const mid of seeds)await db.query('select koi_private.finance_next(m) from koi_private.finance_movements m where workspace_id=$1 and id=$2',[workspace,mid])
  const totals=await db.query(`select type kind,currency,status,count(*)::int count,sum(amount)::text amount from koi_private.finance_movements
    where workspace_id=$1 and source=$2 group by 1,2,3 union all select 'budget',currency,'',count(*)::int,sum(amount)::text
    from koi_private.finance_budgets where workspace_id=$1 and source=$2 group by currency order by 1,2,3`,[workspace,source])
  const expected=await db.query(`select type kind,currency,status,count(*)::int count,sum(amount)::text amount from jsonb_to_recordset($1::jsonb)
    as m(type text,currency text,status text,amount numeric(20,8)) group by 1,2,3 union all select 'budget',currency,'',count(*)::int,sum(budget)::text
    from jsonb_to_recordset($2::jsonb) as b(currency text,budget numeric(18,2)) group by currency order by 1,2,3`,[JSON.stringify(movements),JSON.stringify(budgets)])
  const comparable=(rows:unknown[])=>JSON.stringify((rows as Totals[]).map(r=>[r.kind,r.currency,r.status,r.count,r.amount]))
  return {reviewed:movements.length+budgets.length,inserted,reconciled:comparable(expected.rows)===comparable(totals.rows),totals:totals.rows,
    missingSeries:movements.filter(m=>m.recurrence==='monthly'&&!m.series_id).length}
}
async function main(){
  const [workspace,mode]=process.argv.slice(2)
  const {BACKOFFICE_STAGE_DIR:dir,BACKOFFICE_SOURCE_ID:source,BACKOFFICE_SOURCE_DATABASE_URL:origin,KOI_PROJECT_DATABASE_URL:destination}=process.env
  if(!workspace||!dir||!source||!origin||!destination||!['preview','apply'].includes(mode??''))throw Error('Configurar origen, staging y destino. Uso: workspace preview|apply')
  const reader=new pg.Client({connectionString:origin}),db=new pg.Client({connectionString:destination}),stage=new PGlite(dir)
  try{
    await reader.connect()
    await reader.query('begin isolation level repeatable read read only')
    await reader.query('set local row_security=off')
    const snapshot={financial_movements:(await reader.query('select m.*,m.occurred_on::text,m.due_date::text,m.settled_on::text from public.financial_movements m')).rows,project_financials:(await reader.query('select * from public.project_financials')).rows}
    const identity="case when u.email_confirmed_at is not null then encode(sha256(convert_to(lower(trim(u.email)),'UTF8')),'hex') end identity"
    const owners=(await reader.query<Owner>("select u.id,"+identity+" from auth.users u join public.profiles p on p.id=u.id where p.role='owner'")).rows
    await reader.query('commit')
    const prepared=await prepare(stage,source,workspace,snapshot,true)
    if(prepared.conflicts.length)throw Error(prepared.conflicts.join('\n'))
    await db.connect();await db.query('begin')
    const members=(await db.query<Owner>("select u.id,"+identity+' from auth.users u join public.koi_workspace_members m on m.user_id=u.id where workspace_id=$1',[workspace])).rows
    const permissions=await bindFinanceOwners(db,source,workspace,owners,members)
    const report=await importFinance(stage,db,source,workspace,snapshot)
    if(!report.reconciled)throw Error('Diferencias de conciliación. Revisar el libro del destino antes del corte.')
    await db.query(mode==='apply'?'commit':'rollback')
    console.log({mode,permissions,...report})
  }finally{await reader.end();await db.end();await stage.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(err=>{console.error(err.message);process.exitCode=1})
