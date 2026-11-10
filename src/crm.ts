import type { IncomingMessage } from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { leadInput } from './lead-input.ts'
import { ApiError } from './store.ts'

export type CrmCommand = (action: string, data: Record<string, unknown>) => Promise<unknown>
export const stageSchema = z.enum(['new','contacted','replied','interested','proposal','won','lost'])
const product=z.enum(['','cubiko','zyro','toki','estudio'])
const createLead=leadInput.omit({revision:true}).extend({product:product.default(''),listIds:z.array(z.uuid()).max(100).default([])}).strict()
const bulk=z.object({operation:z.enum(['update','delete']),leads:z.array(z.object({id:z.uuid(),revision:z.number().int().nonnegative()}).strict()).min(1).max(5000),patch:z.object({product:product.optional(),stage:stageSchema.optional(),tags:z.array(z.string().trim().min(1).max(40)).max(20).optional(),assignedTo:z.uuid().nullable().optional(),addListId:z.uuid().optional(),removeListId:z.uuid().optional()}).strict().default({})}).strict()
const filters = z.object({
  product:z.union([product,z.literal('unassigned')]).default(''),
  search:z.string().trim().max(100).default(''), stage:z.union([stageSchema,z.literal('')]).default(''),
  tag:z.string().max(40).default(''), listId:z.union([z.uuid(),z.literal('')]).default(''),
  assignedTo:z.union([z.uuid(),z.literal(''),z.literal('unassigned')]).default(''),
  page:z.coerce.number().int().min(1).max(100000).default(1),
}).strict()
export const crmUpdate = z.object({
  product:product.optional(), revision:z.number().int().nonnegative(), stage:stageSchema.optional(),
  tags:z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  assignedTo:z.uuid().nullable().optional(), nextAction:z.string().trim().max(500).optional(),
  nextActionAt:z.iso.datetime({offset:true}).nullable().optional(),
}).strict().refine(value=>Object.keys(value).length>1,'No hay cambios para guardar.')

export function crmError(error:{code?:string}|null) {
  if(!error)return
  if(error.code==='42501')throw new ApiError(403,'No tenés acceso a este contacto.')
  if(error.code==='PT404')throw new ApiError(404,'No encontramos ese contacto.')
  if(error.code==='PT409'||error.code==='23505')throw new ApiError(409,'No se guardó la operación: un contacto cambió, el teléfono ya existe o hay un envío pendiente de revisión. Actualizá los datos antes de reintentar.')
  if(['23503','23514','22023','22P02','23502'].includes(error.code??''))throw new ApiError(422,'Revisá la etapa, las etiquetas y el responsable del contacto.')
  throw new ApiError(503,'No pudimos consultar los contactos. Volvé a intentar.')
}
export function createCrmStore(client:SupabaseClient):CrmCommand {
  return async(action,data)=>{const result=await client.rpc('koi_crm_command',{p_action:action,p_data:data});if(result.error && (action==='messages'||action.startsWith('message_'))){
    const code=result.error.code
    if(code==='PT409'||code==='23505')throw new ApiError(409,'El mensaje cambió desde que lo abriste. Cerrá el editor, actualizá la lista y volvé a intentar.')
    if(code==='PT404')throw new ApiError(404,'No encontramos ese mensaje.')
    if(code==='42501')throw new ApiError(403,'No tenés acceso a los mensajes de este espacio.')
    if(['23514','23502','22023','22P02'].includes(code))throw new ApiError(422,'Revisá el título, la categoría y el texto del mensaje.')
    throw new ApiError(503,'No pudimos guardar o consultar los mensajes. Volvé a intentar.')
  }crmError(result.error);return result.data}
}
export async function crmRoute(request:IncomingMessage,url:URL,command:CrmCommand,readBody:()=>Promise<unknown>) {
  const path=url.pathname.replace('/api/crm','')
  const messageFields=z.object({title:z.string().trim().min(1).max(120),category:z.string().trim().min(1).max(40),body:z.string().trim().min(1).max(4000)}).strict()
  if(path==='/messages'&&request.method==='GET')return {status:200,data:await command('messages',z.object({search:z.string().trim().max(100).default(''),category:z.string().max(40).default(''),archived:z.enum(['true','false']).default('false').transform(v=>v==='true'),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().parse(Object.fromEntries(url.searchParams)))}
  if(path==='/messages'&&request.method==='POST')return {status:201,data:await command('message_create',{...messageFields.parse(await readBody()),key:z.uuid().parse(request.headers['idempotency-key'])})}
  const message=/^\/messages\/([^/]+)$/.exec(path)
  if(message&&request.method==='PATCH')return {status:200,data:await command('message_update',{id:z.uuid().parse(message[1]),...messageFields.partial().extend({revision:z.number().int().nonnegative(),archived:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>1).parse(await readBody())})}
  if(path==='/tasks'&&request.method==='GET')return {status:200,data:await command('tasks',z.object({view:z.enum(['pending','today','overdue','completed']).default('pending'),owner:z.enum(['all','mine','unassigned']).default('all'),leadId:z.uuid().optional(),search:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)}).strict().parse(Object.fromEntries(url.searchParams)))}
  if(path==='/tasks'&&request.method==='POST')return {status:201,data:await command('task_create',{...z.object({leadId:z.uuid(),title:z.string().trim().min(1).max(500),dueAt:z.iso.datetime({offset:true}).nullable()}).strict().parse(await readBody()),key:z.uuid().parse(request.headers['idempotency-key'])})}
  const task=/^\/tasks\/([^/]+)$/.exec(path)
  if(task&&request.method==='PATCH')return {status:200,data:await command('task_update',{id:z.uuid().parse(task[1]),...z.object({revision:z.number().int().nonnegative(),title:z.string().trim().min(1).max(500).optional(),dueAt:z.iso.datetime({offset:true}).nullable().optional(),status:z.enum(['pending','completed']).optional()}).strict().refine(v=>Object.keys(v).length>1).parse(await readBody())})}
  if(request.method==='GET'&&['/leads','/board','/options','/summary'].includes(path))return {status:200,data:await command(path==='/leads'?'list':path.slice(1),filters.parse(Object.fromEntries(url.searchParams)))}
  if(request.method==='POST'&&path==='/leads')return {status:201,data:await command('create',{...createLead.parse(await readBody()),key:z.uuid().parse(request.headers['idempotency-key'])})}
  if(request.method==='POST'&&path==='/bulk')return {status:200,data:await command('bulk',{...bulk.parse(await readBody()),key:z.uuid().parse(request.headers['idempotency-key'])})}
  const match=/^\/leads\/([^/]+)(?:\/(notes|history))?$/.exec(path)
  if(!match)throw new ApiError(404,'Operación no encontrada.')
  const id=z.uuid().parse(match[1])
  if(request.method==='GET')return {status:200,data:await command(match[2]??'detail',{id,page:filters.parse(Object.fromEntries(url.searchParams)).page})}
  if(request.method==='PATCH'&&!match[2])return {status:200,data:await command('update',{id,...crmUpdate.parse(await readBody())})}
  if(request.method==='POST'&&match[2]==='notes')return {status:201,data:await command('note',{id,key:z.uuid().parse(request.headers['idempotency-key']),...z.object({body:z.string().trim().min(1).max(4000)}).strict().parse(await readBody())})}
  throw new ApiError(405,'Método no permitido.')
}
