import { Pool, escapeLiteral } from 'pg'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const adminUrl=process.env.KOI_ADMIN_DATABASE_URL, workspace=process.env.KOI_EVOLUTION_WORKSPACE_ID
if(!adminUrl||!workspace||!/^[a-f0-9-]{36}$/i.test(workspace))throw new Error('Falta conexión administrativa o workspace válido.')
const url=new URL(adminUrl)
if(!['postgres:','postgresql:'].includes(url.protocol)||url.port==='6543')throw new Error('Usá conexión directa o Session Pooler.')
for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key)
const pool=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:10000,
 ssl:{rejectUnauthorized:true,ca:readFileSync(process.env.KOI_DATABASE_CA_FILE??new URL('../certs/supabase-prod-ca-2021.crt',import.meta.url),'utf8')}})
try {
 const role=await pool.query("select rolcanlogin from pg_roles where rolname='koi_chat_worker'")
 if(!role.rowCount)throw new Error('Primero aplicar la migración de despacho manual.')
 if(role.rows[0].rolcanlogin)throw new Error('El rol ya está activo; no se rotan credenciales automáticamente.')
 if(!(await pool.query('select 1 from koi_private.senders where workspace_id=$1',[workspace])).rowCount)throw new Error('Emisor no encontrado.')
 const password=randomBytes(32).toString('hex'), output=resolve(process.env.KOI_PROVISION_OUTPUT??'.local-campaigns')
 const connection=new URL(url), username=decodeURIComponent(url.username)
 connection.username='koi_chat_worker'+(username.includes('.')?'.'+username.split('.').slice(1).join('.'):'')
 connection.password=password
 await mkdir(output,{recursive:true,mode:0o700})
 await writeFile(resolve(output,'chat-worker.env'),`KOI_CHAT_WORKER_DATABASE_URL=${connection}
KOI_CHAT_SEND_ENABLED=false
KOI_WORKER_KIND=chat
KOI_EVOLUTION_WORKSPACE_ID=${workspace}
`,{mode:0o600,flag:'wx'})
 await pool.query('begin')
 await pool.query("insert into koi_private.machine_bindings(role_name,workspace_id,kind) values('koi_chat_worker',$1,'chat-worker')",[workspace])
 await pool.query('alter role koi_chat_worker login password '+escapeLiteral(password))
 await pool.query('commit')
 console.log('Credenciales de chat guardadas localmente. Completar Evolution y cargar en el servicio de chat; no subir a Git.')
} catch {
 await pool.query('rollback').catch(()=>{})
 console.error('No se completó la provisión. Revisá migración, workspace y si el rol o archivo ya existen; no publiques credenciales.')
 process.exitCode=1
} finally { await pool.end() }
