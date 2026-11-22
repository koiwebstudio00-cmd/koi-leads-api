import { createHash,randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ApiError,type UserStore } from './store.ts'
import {seal,unseal,type VaultKeys} from './vault-crypto.ts'

const kind=z.enum(['credential','env'])
export const vaultContent=z.object({value:z.string().min(1).max(131072),username:z.string().max(500),url:z.string().max(2000),notes:z.string().max(32000)}).strict()
const revision=z.int().nonnegative()
export const portalQuery=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),fileId:z.uuid().optional()}).strict()
export type SensitiveServices={
  keys?:VaultKeys
  revalidate:(user:UserStore,password:string)=>Promise<boolean>
  publicRead:(query:z.infer<typeof portalQuery>)=>Promise<unknown>
}
export function sensitiveServices(url:string,key:string,keys?:VaultKeys):SensitiveServices{
  const client=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}})
  const reader=client()
  return {keys,async revalidate(store,password){
    if(!store.email)return false
    const temporary=client()
    const result=await temporary.auth.signInWithPassword({email:store.email,password})
    if(result.error||!result.data.session)return false
    try{return result.data.user.id===store.userId}finally{await temporary.auth.signOut({scope:'local'})}
  },async publicRead({token,fileId}){
    const {data,error}=await reader.rpc('koi_read_client_portal',{token,file_id:fileId??null})
    if(error)throw new ApiError(error.code==='PT404'?404:503,error.code==='PT404'?'El enlace o el archivo ya no está disponible.':'No pudimos consultar el portal.')
    return data
  }}
}
export async function sensitiveRoute(path:string,method:string|undefined,store:UserStore,services:SensitiveServices|undefined,body:()=>Promise<unknown>){
  if(!store.crm)throw new ApiError(503,'El servicio no está disponible.')
  const call=(action:string,data:Record<string,unknown>={})=>store.crm!('sensitive:'+action,data)
  if(path==='/api/secure/access'&&method==='GET')return call('access')
  if(path==='/api/secure/vault'&&method==='GET')return call('vault_list')
  const vault=/^\/api\/secure\/vault\/([^/]+)(?:\/(audit|reveal))?$/.exec(path)
  if(vault){
    const id=z.uuid().parse(vault[1])
    if(method==='GET'&&vault[2]==='audit')return call('vault_audit',{id})
    if(!(await call('access') as {vault:boolean}).vault)throw new ApiError(403,'Acceso a bóveda restringido.')
    if(!services?.keys)throw new ApiError(503,'La llave de bóveda todavía no está configurada.')
    const workspace=store.membership.workspace_id
    if(method==='PUT'&&!vault[2]){
      const {secret,...fields}=z.object({kind,label:z.string().trim().min(1).max(160),revision:z.int().min(-1),projectId:z.uuid().nullable(),clientId:z.uuid().nullable(),secret:vaultContent}).strict().parse(await body())
      return call('vault_save',{...fields,id,...seal(services.keys,{workspace,id,kind:fields.kind},JSON.stringify(secret))})
    }
    if(method==='POST'&&vault[2]==='reveal'){
      const {password}=z.object({password:z.string().min(1).max(1024)}).strict().parse(await body())
      if(!await services.revalidate(store,password))throw new ApiError(403,'No pudimos revalidar tu identidad.')
      const wrapped=await call('vault_reveal',{id}) as {kind:string;version:number;envelope:string}
      return vaultContent.parse(JSON.parse(unseal(services.keys,{workspace,id,kind:wrapped.kind},wrapped.version,wrapped.envelope)))
    }
  }
  const portal=/^\/api\/secure\/portals\/([^/]+)(?:\/(publish|rotate|revoke))?$/.exec(path)
  if(portal){
    const clientId=z.uuid().parse(portal[1])
    if(method==='GET'&&!portal[2])return call('portal_detail',{clientId})
    if(method==='POST'&&portal[2]==='publish'){
      const fields=z.object({revision,choices:z.array(z.object({kind:z.enum(['project','note','payment','file']),id:z.uuid()}).strict()).max(5000)}).strict().parse(await body())
      return call('portal_publish',{clientId,...fields})
    }
    if(method==='POST'&&(portal[2]==='rotate'||portal[2]==='revoke')){
      const fields=z.object({revision}).strict().parse(await body())
      if(portal[2]==='revoke')return call('portal_revoke',{clientId,...fields})
      const token=randomBytes(32).toString('base64url')
      await call('portal_rotate',{clientId,...fields,hash:createHash('sha256').update(token).digest('hex')})
      return {token}
    }
  }
  throw new ApiError(405,'Operación no permitida.')
}
