// Configuración inicial/reanudable. No imprime claves ni guarda credenciales en Git.
import { Pool,escapeIdentifier,escapeLiteral } from 'pg'
import { randomBytes } from 'node:crypto'
import { readFileSync,writeFileSync,chmodSync,existsSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { machineConnectionOptions } from '../src/campaigns/machine-store.ts'
import { readConfig } from '../src/config.ts'
import { createZernioClient,accountSchema,accountRecord } from '../src/inbox/provider.ts'
import { z } from 'zod'

const pendingPath=resolve('.env.zernio.local'),apiPath=resolve('.env'),workerPath=resolve('.env.inbox-worker')
const admin=parseEnv(readFileSync('.env.provision','utf8')),pending=parseEnv(readFileSync(pendingPath,'utf8'))
const setup=z.object({ZERNIO_API_KEY:z.string().min(16),ZERNIO_PROFILE_ID:z.string().min(1),
 ZERNIO_WEBHOOK_SECRET:z.string().min(32),KOI_ZERNIO_WORKSPACE_ID:z.uuid()}).safeParse(pending)
if(!setup.success||!admin.KOI_ADMIN_DATABASE_URL)throw new Error('Completá la configuración privada antes de provisionar Inbox.')
const config=setup.data,workspace=config.KOI_ZERNIO_WORKSPACE_ID
const ca=resolve('certs/supabase-prod-ca-2021.crt'),source=new URL(admin.KOI_ADMIN_DATABASE_URL)
if(source.port==='6543')throw new Error('La provisión requiere conexión directa o Session Pooler.')
const db=new Pool({...machineConnectionOptions(source.toString(),ca),max:1})
const connections=[
 {role:'koi_inbox_api_login',group:'koi_inbox_gateway',kind:'gateway',key:'KOI_INBOX_GATEWAY_DATABASE_URL'},
 {role:'koi_inbox_ingest_login',group:'koi_inbox_ingest',kind:'ingest',key:'KOI_INBOX_INGEST_DATABASE_URL'},
] as const
function setValue(text:string,key:string,value:string){
 const pattern=new RegExp('^\\s*(?:export\\s+)?'+key+'\\s*=.*$','m'),line=key+'='+JSON.stringify(value)
 return pattern.test(text)?text.replace(pattern,()=>line):text.trimEnd()+'\n'+line+'\n'
}
function save(path:string,text:string){writeFileSync(path,text,{mode:0o600});chmodSync(path,0o600)}
function safeCode(error:unknown){const code=(error as {code?:unknown}).code;return typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'CONFIGURATION_OR_CONNECTION'}
try{
 const members=await db.query<{user_id:string}>('select user_id from public.koi_workspace_members where workspace_id=$1 and role=\'admin\' order by user_id',[workspace])
 const actor=pending.KOI_INBOX_ACTOR_ID??(members.rows.length===1?members.rows[0]!.user_id:undefined)
 if(!actor||!members.rows.some(m=>m.user_id===actor))throw new Error('Elegí un administrador válido para el binding.')
 const groups=await db.query('select rolname from pg_roles where rolname=any($1) and not rolcanlogin and not rolsuper and not rolbypassrls',[connections.map(c=>c.group)])
 if(groups.rows.length!==2)throw new Error('Primero aplicar las migraciones Inbox.')
 let pendingText=readFileSync(pendingPath,'utf8')
 for(const c of connections){
  if(!pending[c.key]){
   if((await db.query('select 1 from pg_roles where rolname=$1',[c.role])).rowCount)throw new Error('El login ya existe; recuperar su credencial, no rotarla automáticamente.')
   const url=new URL(source),username=decodeURIComponent(source.username),suffix=username.includes('.')?'.'+username.split('.').slice(1).join('.'):''
   url.username=c.role+suffix;url.password=randomBytes(32).toString('hex')
   for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key)
   pending[c.key]=url.toString()
  }
  const target=new URL(pending[c.key]!)
  if(target.hostname!==source.hostname||target.port!==source.port||target.pathname!==source.pathname||decodeURIComponent(target.username).split('.')[0]!==c.role)throw new Error('La credencial guardada apunta a otro servicio.')
  pendingText=setValue(pendingText,c.key,pending[c.key]!)
 }
 pendingText=setValue(pendingText,'KOI_DATABASE_CA_FILE',ca)
 // Guardar antes de crear los logins permite recuperar una ejecución interrumpida.
 save(pendingPath,pendingText)
 await db.query('begin')
 await db.query("select pg_advisory_xact_lock(hashtext('koi-inbox-provision'))")
 for(const c of connections){
  const existing=await db.query<{rolcanlogin:boolean;rolsuper:boolean;rolbypassrls:boolean;rolcreatedb:boolean;rolcreaterole:boolean}>('select rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=$1',[c.role])
  if(!existing.rowCount){
   const password=decodeURIComponent(new URL(pending[c.key]!).password)
   await db.query(`create role ${escapeIdentifier(c.role)} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4 password ${escapeLiteral(password)}`)
   await db.query(`grant ${escapeIdentifier(c.group)} to ${escapeIdentifier(c.role)}`)
  }else{
   const role=existing.rows[0]!
   if(!role.rolcanlogin||role.rolsuper||role.rolbypassrls||role.rolcreatedb||role.rolcreaterole)throw new Error('El login existente tiene una configuración inesperada.')
  }
  await db.query('insert into koi_private.inbox_bindings(role_name,workspace_id,profile_id,actor_id,kind) values($1,$2,$3,$4,$5) on conflict do nothing',[c.role,workspace,config.ZERNIO_PROFILE_ID,actor,c.kind])
  const valid=await db.query('select 1 from koi_private.inbox_bindings where role_name=$1 and workspace_id=$2 and profile_id=$3 and actor_id=$4 and kind=$5 and pg_has_role($1::name,$6::name,\'member\')',[c.role,workspace,config.ZERNIO_PROFILE_ID,actor,c.kind,c.group])
  if(valid.rowCount!==1)throw new Error('El binding existente no corresponde a esta configuración.')
 }
 await db.query('commit')
 for(const c of connections){
  const test=new Pool({...machineConnectionOptions(pending[c.key]!,ca),max:1})
  try{
   const result=await test.query<{result:{workspaceId:string;profileId:string}}>("select koi_private.inbox_command('context','{}') result")
   if(result.rows[0]?.result.workspaceId!==workspace||result.rows[0]?.result.profileId!==config.ZERNIO_PROFILE_ID)throw new Error('Contexto de conexión incorrecto.')
   let denied=false
   try{await test.query('select koi_private.inbox_command($1,$2)',[c.kind==='gateway'?'claim_event':'list','{}'])}catch(error){denied=(error as {code?:string}).code==='42501'}
   if(!denied)throw new Error('El login permite una operación ajena.')
   denied=false
   try{await test.query('select id from koi_private.inbox_messages limit 0')}catch(error){denied=(error as {code?:string}).code==='42501'}
   if(!denied)throw new Error('El login permite acceso directo a mensajes.')
   console.log(JSON.stringify({event:'inbox_login_verified',kind:c.kind}))
  }finally{await test.end()}
 }
 // La API no recibe la contraseña del worker y el worker no recibe la del gateway.
 let apiText=readFileSync(apiPath,'utf8')
 const apiValues={...config,KOI_INBOX_GATEWAY_DATABASE_URL:pending.KOI_INBOX_GATEWAY_DATABASE_URL!,KOI_DATABASE_CA_FILE:ca}
 for(const [key,value] of Object.entries(apiValues))apiText=setValue(apiText,key,value)
 readConfig(parseEnv(apiText))
 save(apiPath,apiText)
 const previousWorker=existsSync(workerPath)?parseEnv(readFileSync(workerPath,'utf8')):{}
 const workerValues={KOI_INBOX_SEND_ENABLED:previousWorker.KOI_INBOX_SEND_ENABLED==='true'?'true':'false',KOI_INBOX_INGEST_DATABASE_URL:pending.KOI_INBOX_INGEST_DATABASE_URL!,ZERNIO_API_KEY:config.ZERNIO_API_KEY,ZERNIO_PROFILE_ID:config.ZERNIO_PROFILE_ID,KOI_ZERNIO_WORKSPACE_ID:workspace,KOI_DATABASE_CA_FILE:ca}
 save(workerPath,Object.entries(workerValues).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n')
 if(process.argv.includes('--sync-accounts')){
  const response=await fetch('https://zernio.com/api/v1/accounts?profileId='+encodeURIComponent(config.ZERNIO_PROFILE_ID),{headers:{Authorization:'Bearer '+config.ZERNIO_API_KEY},redirect:'error',signal:AbortSignal.timeout(15000)})
  if(!response.ok)throw new Error('No se pudo consultar Zernio.')
  const list=z.object({accounts:z.array(z.object({_id:z.string(),platform:z.string()}))}).parse(await response.json())
  const provider=createZernioClient(config.ZERNIO_API_KEY)
  for(const item of list.accounts.filter(a=>['whatsapp','instagram'].includes(a.platform))){
   const account=accountSchema.parse(await provider.account(item._id)),record=accountRecord(account,config.ZERNIO_PROFILE_ID)
   // Adopta únicamente cuentas existentes verificadas por el proveedor; no crea un webhook ficticio ni repite OAuth.
   await db.query('select koi_private.inbox_save_account($1,$2,$3)',[workspace,actor,JSON.stringify(record)])
   console.log(JSON.stringify({event:'inbox_existing_account_registered',channel:record.channel,state:record.state}))
  }
 }
 console.log('Inbox configurado. Reiniciar API y ejecutar npm run worker:inbox-ingest. No se enviaron mensajes.')
}catch(error){
 await db.query('rollback').catch(()=>{})
 console.error(JSON.stringify({event:'inbox_provision_failed',code:safeCode(error)}))
 process.exitCode=1
}finally{await db.end()}
