import { createHash,randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { ApiError,type UserStore } from '../store.ts'
import type { MachineCommand } from '../campaigns/machine-store.ts'
import { accountRecord,channel,type ZernioClient } from './provider.ts'

export const connectInput=z.object({channel,reconnectId:z.string().min(1).max(200).optional()}).strict()
export const completeInput=z.object({state:z.string().regex(/^[a-f0-9]{64}$/),accountId:z.string().min(1).max(200)}).strict()
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
export function safeConnectUrl(value:string){
  const url=new URL(value)
  if(url.protocol!=='https:'||(url.port!==''&&url.port!=='443')||url.username||url.password||!['zernio.com','www.facebook.com','facebook.com','www.instagram.com','api.instagram.com','instagram.com'].includes(url.hostname))throw new ApiError(503,'Zernio devolvió un destino de conexión no válido.')
  return url.toString()
}
export function createInboxService(options:{workspaceId:string;profileId:string;origin:string;command:MachineCommand;provider:ZernioClient}){
  const {provider,profileId,workspaceId}=options
  const command:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
    try{return await options.command<T>(action,data)}catch(error){
      const code=(error as {code?:string}).code
      if(code==='42501')throw new ApiError(403,'La autorización de conexión venció o no corresponde a esta cuenta. Volvé a conectar.')
      if(code==='22023'||code==='23514')throw new ApiError(422,'Los datos de la conexión no son válidos.')
      throw error
    }
  }
  async function scoped(store:UserStore,admin:boolean){
    if(store.membership.workspace_id!==workspaceId||(admin&&store.membership.role!=='admin'))throw new ApiError(403,'No tenés permiso para gestionar estas conexiones.')
    const binding=await command<{workspaceId:string;profileId:string}>('context',{})
    if(binding.workspaceId!==workspaceId||binding.profileId!==profileId)throw new ApiError(503,'La conexión Inbox necesita revisar su configuración.')
  }
  return async(request:IncomingMessage,url:URL,store:UserStore,body:()=>Promise<unknown>)=>{
    await scoped(store,request.method!=='GET')
    const profileRoute=/^\/api\/inbox\/conversations\/([^/]+)\/instagram-profile$/.exec(url.pathname)
    if(profileRoute && request.method==='GET'){
      if(!store.inbox)throw new ApiError(503,'Inbox no disponible.')
      const id=z.uuid().parse(profileRoute[1])
      const lookup=await store.inbox('instagram_profile_locator',{id}) as {accountId:string;conversationId:string}
      const account=await provider.account(lookup.accountId)
      if(account._id!==lookup.accountId || account.profileId!==profileId || account.platform!=='instagram')throw new ApiError(403,'El perfil pertenece a otra cuenta.')
      return {username:await provider.instagramContact(lookup.accountId,lookup.conversationId)}
    }
    const actorId=store.userId
    if(url.pathname==='/api/inbox/connections'&&request.method==='GET')return {configured:true,...await command<Record<string,unknown>>('list',{actorId})}
    if(url.pathname==='/api/inbox/connections/connect'&&request.method==='POST'){
      const input=connectInput.parse(await body()),state=randomBytes(32).toString('hex')
      await command('begin_connect',{actorId,channel:input.channel,reconnectId:input.reconnectId,hash:hash(state)})
      const redirect=new URL('/configuracion/conexiones',options.origin)
      redirect.searchParams.set('koiState',state)
      const result=await provider.connect(input.channel,profileId,redirect.toString(),input.reconnectId)
      return {url:safeConnectUrl(result.authUrl)}
    }
    if(url.pathname==='/api/inbox/connections/complete'&&request.method==='POST'){
      const input=completeInput.parse(await body())
      const account=accountRecord(await provider.account(input.accountId),profileId)
      return command('complete_connect',{actorId,hash:hash(input.state),account})
    }
    if(url.pathname==='/api/inbox/connections/refresh'&&request.method==='POST'){
      const {accountId}=z.object({accountId:z.string().min(1).max(200)}).strict().parse(await body())
      const account=accountRecord(await provider.account(accountId),profileId)
      return command('refresh_account',{actorId,account})
    }
    if(url.pathname==='/api/inbox/connections/retry'&&request.method==='POST'){
      z.object({}).strict().parse(await body())
      return command('retry',{actorId})
    }
    throw new ApiError(404,'No encontramos esa operación de Inbox.')
  }
}
export type InboxService=ReturnType<typeof createInboxService>
