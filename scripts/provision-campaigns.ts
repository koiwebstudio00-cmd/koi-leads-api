// Ejecutar una vez después de la migración, fuera del runtime de la API.
// No imprime secretos ni lee/escribe datos de leads.
import { Pool, escapeLiteral } from 'pg'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const adminUrl=process.env.KOI_ADMIN_DATABASE_URL
const instance=process.env.EVOLUTION_INSTANCE_NAME
const workspace=process.env.KOI_EVOLUTION_WORKSPACE_ID
if(!adminUrl||!instance||!workspace||!/^[A-Za-z0-9_-]{1,100}$/.test(instance)||!/^[a-f0-9-]{36}$/i.test(workspace))throw new Error('Faltan KOI_ADMIN_DATABASE_URL, EVOLUTION_INSTANCE_NAME o KOI_EVOLUTION_WORKSPACE_ID válidos.')
const url=new URL(adminUrl)
if(!['postgres:','postgresql:'].includes(url.protocol)||url.port==='6543')throw new Error('Usá conexión directa o Session Pooler (5432), no Transaction Pooler.')
for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key)
const pool=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:true,...(process.env.KOI_DATABASE_CA_FILE?{ca:readFileSync(process.env.KOI_DATABASE_CA_FILE,'utf8')}:{})}})
const folder=resolve(process.env.KOI_PROVISION_OUTPUT??'.local-campaigns')
const workerPassword=randomBytes(32).toString('hex'),hookPassword=randomBytes(32).toString('hex'),webhookSecret=randomBytes(32).toString('hex')
function machineUrl(role:string,password:string){const result=new URL(url);const suffix=decodeURIComponent(result.username).includes('.')?'.'+decodeURIComponent(result.username).split('.').slice(1).join('.'):'';result.username=role+suffix;result.password=password;return result.toString()}
try {
 const active=await pool.query("select 1 from pg_roles where rolname in ('koi_campaign_worker','koi_campaign_webhook') and rolcanlogin")
 if(active.rowCount)throw new Error('Los roles ya fueron activados; no se rotan ni reasignan automáticamente.')
 await mkdir(folder,{recursive:true,mode:0o700})
 // Guardar antes de mutar: si falla la conexión, las credenciales siguen siendo recuperables localmente.
 await writeFile(resolve(folder,'worker.env'),`KOI_WORKER_DATABASE_URL=${machineUrl('koi_campaign_worker',workerPassword)}\nKOI_SEND_ENABLED=false\nKOI_WORKER_POLL_MS=3000\nKOI_EVOLUTION_WORKSPACE_ID=${workspace}\nEVOLUTION_INSTANCE_NAME=${instance}\n`,{mode:0o600,flag:'wx'})
 await writeFile(resolve(folder,'api-webhook.env'),`KOI_WEBHOOK_DATABASE_URL=${machineUrl('koi_campaign_webhook',hookPassword)}\nKOI_EVOLUTION_WEBHOOK_SECRET=${webhookSecret}\n`,{mode:0o600,flag:'wx'})
 await pool.query('begin')
 if(!(await pool.query('select 1 from public.koi_workspaces where id=$1',[workspace])).rowCount)throw new Error('Espacio no encontrado')
 await pool.query("insert into koi_private.senders(workspace_id,instance) values($1,$2) on conflict(workspace_id) do update set instance=excluded.instance",[workspace,instance])
 await pool.query("insert into koi_private.machine_bindings(role_name,workspace_id,kind) values('koi_campaign_worker',$1,'worker'),('koi_campaign_webhook',$1,'webhook') on conflict(role_name) do update set workspace_id=excluded.workspace_id,kind=excluded.kind",[workspace])
 await pool.query('alter role koi_campaign_worker login password '+escapeLiteral(workerPassword))
 await pool.query('alter role koi_campaign_webhook login password '+escapeLiteral(hookPassword))
 await pool.query('commit')
 console.log('Credenciales creadas en '+folder+'. Cargalas en Dokploy según docs/despliegue-campanas.md. No subas esta carpeta a Git.')
}catch{await pool.query('rollback').catch(()=>{});console.error('No se completó la provisión. Revisá conexión, permisos y si la carpeta de salida ya existe. No publiques sus archivos.');process.exitCode=1}finally{await pool.end()}
