import type { IncomingMessage } from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ApiError } from './store.ts'

export type CrmCommand = (action: string, data: Record<string, unknown>) => Promise<unknown>
export const stageSchema = z.enum(['new','contacted','replied','interested','proposal','won','lost'])
const filters = z.object({
  search:z.string().trim().max(100).default(''), stage:z.union([stageSchema,z.literal('')]).default(''),
  tag:z.string().max(40).default(''), listId:z.union([z.uuid(),z.literal('')]).default(''),
  assignedTo:z.union([z.uuid(),z.literal(''),z.literal('unassigned')]).default(''),
  page:z.coerce.number().int().min(1).max(100000).default(1),
}).strict()
export const crmUpdate = z.object({
  revision:z.number().int().nonnegative(), stage:stageSchema.optional(),
  tags:z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  assignedTo:z.uuid().nullable().optional(), nextAction:z.string().trim().max(500).optional(),
  nextActionAt:z.iso.datetime({offset:true}).nullable().optional(),
}).strict().refine(value=>Object.keys(value).length>1,'No hay cambios para guardar.')

export function crmError(error:{code?:string}|null) {
  if(!error)return
  if(error.code==='42501')throw new ApiError(403,'No tenés acceso a este contacto.')
  if(error.code==='PT404')throw new ApiError(404,'No encontramos ese contacto.')
  if(error.code==='PT409')throw new ApiError(409,'El contacto cambió. Actualizá la ficha antes de guardar nuevamente.')
  if(['23503','23514','22023','22P02','23502'].includes(error.code??''))throw new ApiError(422,'Revisá la etapa, las etiquetas y el responsable del contacto.')
  throw new ApiError(503,'No pudimos consultar los contactos. Volvé a intentar.')
}
export function createCrmStore(client:SupabaseClient):CrmCommand {
  return async(action,data)=>{const result=await client.rpc('koi_crm_command',{p_action:action,p_data:data});crmError(result.error);return result.data}
}
export async function crmRoute(request:IncomingMessage,url:URL,command:CrmCommand,readBody:()=>Promise<unknown>) {
  const path=url.pathname.replace('/api/crm','')
  if(request.method==='GET'&&['/leads','/board','/options'].includes(path))return {status:200,data:await command(path==='/leads'?'list':path.slice(1),filters.parse(Object.fromEntries(url.searchParams)))}
  const match=/^\/leads\/([^/]+)(?:\/(notes|history))?$/.exec(path)
  if(!match)throw new ApiError(404,'Operación no encontrada.')
  const id=z.uuid().parse(match[1])
  if(request.method==='GET')return {status:200,data:await command(match[2]??'detail',{id,page:filters.parse(Object.fromEntries(url.searchParams)).page})}
  if(request.method==='PATCH'&&!match[2])return {status:200,data:await command('update',{id,...crmUpdate.parse(await readBody())})}
  if(request.method==='POST'&&match[2]==='notes')return {status:201,data:await command('note',{id,key:z.uuid().parse(request.headers['idempotency-key']),...z.object({body:z.string().trim().min(1).max(4000)}).strict().parse(await readBody())})}
  throw new ApiError(405,'Método no permitido.')
}
