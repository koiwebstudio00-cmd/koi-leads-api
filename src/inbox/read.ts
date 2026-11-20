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
 if(error.code==='PT422')throw new ApiError(422,'La ventana de 24 horas está cerrada o la cuenta está desconectada. Conservá el borrador hasta que el contacto vuelva a escribir.')
 if(error.code==='PT423')throw new ApiError(423,'Hay un envío sin confirmar. Revisalo antes de enviar otro mensaje.')
 if(error.code==='PT409')throw new ApiError(409,'La solicitud ya existe con otro contenido o el estado del envío cambió. Actualizá el chat.')
 if(['22023','22P02','23514'].includes(error.code??''))throw new ApiError(422,'Revisá los parámetros de Inbox.')
 throw new ApiError(503,'No pudimos consultar Inbox. Volvé a intentar.')
}
export function createInboxQuery(client:SupabaseClient):InboxQuery{return async(action,data)=>{
 const result=await client.rpc(['send','resolve_send'].includes(action)?'koi_inbox_send':'koi_inbox_query',{action,data});inboxQueryError(result.error);return result.data
}}
export async function inboxReadRoute(request:IncomingMessage,url:URL,query:InboxQuery,readBody:()=>Promise<unknown>,media?:InboxReadMedia,sendEnabled=false){
 if(request.method==='GET'){
  if(url.pathname==='/api/inbox/capabilities')return {sendText:sendEnabled}
  if(url.pathname==='/api/inbox/accounts')return query('accounts',{})
  if(url.pathname==='/api/inbox/unread-count')return query('unread_count',{})
  if(url.pathname==='/api/inbox/index')return query('index',inboxIndexQuery.parse({after:url.searchParams.get('after')??undefined,ids:url.searchParams.has('ids')?url.searchParams.get('ids')!.split(','):undefined}))
 }
 const match=/^\/api\/inbox\/conversations\/([^/]+)(?:\/(messages|actions|attachments|resolve-send))?$/.exec(url.pathname)
 if(!match)throw new ApiError(404,'No encontramos esa operación de Inbox.')
 const id=z.uuid().parse(match[1])
 if(request.method==='POST'&&(match[2]==='messages'||match[2]==='resolve-send')){
  if(!sendEnabled)throw new ApiError(503,'El envío de Inbox todavía no está habilitado.')
  if(match[2]==='resolve-send')return query('resolve_send',{id,...z.object({messageId:z.uuid()}).strict().parse(await readBody())})
  const body=z.object({text:z.string().trim().min(1).max(10000)}).strict().parse(await readBody())
  const requestId=z.uuid().parse(request.headers['idempotency-key'])
  return query('send',{id,...body,requestId})
 }
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
