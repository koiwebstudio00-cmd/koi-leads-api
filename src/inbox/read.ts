import type { IncomingMessage } from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ApiError } from '../store.ts'
import { inboxAction,inboxIndexQuery,inboxMessageQuery } from './contracts.ts'
export type InboxQuery=(action:string,data:Record<string,unknown>)=>Promise<unknown>
export type MediaLookup={accountId:string;conversationId:string;messageId:string;index:number;name:string}
export type InboxReadMedia=(lookup:MediaLookup)=>Promise<{mime:string;name:string;base64:string}>
export function inboxQueryError(error:{code?:string}|null){
 if(!error)return
 if(error.code==='42501')throw new ApiError(403,'No tenés permiso para esta conversación de Inbox.')
 if(error.code==='PT404')throw new ApiError(404,'No encontramos la conversación o el mensaje de Inbox.')
 if(['22023','22P02','23514'].includes(error.code??''))throw new ApiError(422,'Revisá los parámetros de Inbox.')
 throw new ApiError(503,'No pudimos consultar Inbox. Volvé a intentar.')
}
export function createInboxQuery(client:SupabaseClient):InboxQuery{return async(action,data)=>{
 const result=await client.rpc('koi_inbox_query',{action,data});inboxQueryError(result.error);return result.data
}}
export async function inboxReadRoute(request:IncomingMessage,url:URL,query:InboxQuery,readBody:()=>Promise<unknown>,media?:InboxReadMedia){
 if(request.method==='GET'){
  if(url.pathname==='/api/inbox/accounts')return query('accounts',{})
  if(url.pathname==='/api/inbox/unread-count')return query('unread_count',{})
  if(url.pathname==='/api/inbox/index')return query('index',inboxIndexQuery.parse({after:url.searchParams.get('after')??undefined,ids:url.searchParams.has('ids')?url.searchParams.get('ids')!.split(','):undefined}))
 }
 const match=/^\/api\/inbox\/conversations\/([^/]+)(?:\/(messages|actions|attachments))?$/.exec(url.pathname)
 if(!match)throw new ApiError(404,'No encontramos esa operación de Inbox.')
 const id=z.uuid().parse(match[1])
 if(request.method==='GET'&&(!match[2]||match[2]==='messages'))return query('messages',{id,...inboxMessageQuery.parse({before:url.searchParams.get('before')??undefined,limit:Number(url.searchParams.get('limit')??50)})})
 if(request.method==='POST'&&match[2]==='actions'){
  const {action,...data}=inboxAction.parse(await readBody());return query(action,{id,...data})
 }
 if(request.method==='GET'&&match[2]==='attachments'){
  const data=z.object({messageId:z.uuid(),index:z.coerce.number().int().min(0).max(99)}).parse({messageId:url.searchParams.get('messageId'),index:url.searchParams.get('index')})
  const lookup=await query('media_lookup',{id,...data}) as MediaLookup
  if(!media)throw new ApiError(503,'La consulta de archivos de Inbox todavía no está habilitada.')
  return media(lookup)
 }
 throw new ApiError(405,'Método no permitido en Inbox.')
}
