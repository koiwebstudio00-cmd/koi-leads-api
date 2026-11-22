import { z } from 'zod'
import type { IncomingMessage } from 'node:http'
import type { CrmCommand } from './crm.ts'
import { ApiError } from './store.ts'

const currency=z.enum(['ARS','USD','USDT'])
const method=z.enum(['transfer','crypto','cash','card','other']).nullable()
const scope=z.object({clientId:z.uuid().optional(),projectId:z.uuid().optional()}).strict()
const movement=scope.extend({type:z.enum(['income','expense']),status:z.enum(['pending','settled']),concept:z.string().trim().min(1).max(160),
  category:z.string().trim().min(1).max(80),amount:z.string().regex(/^\d{1,12}(\.\d{1,8})?$/),currency,payment_method:method,
  occurred_on:z.iso.date(),due_date:z.iso.date().nullable(),settled_on:z.iso.date().nullable(),notes:z.string().max(8000),recurrence:z.enum(['none','monthly'])})
export async function financeRoute(request:IncomingMessage,path:string,url:URL,command:CrmCommand,body:()=>Promise<unknown>){
  const call=async(action:string,data:Record<string,unknown>)=>({status:200,data:await command('finance:'+action,data)})
  const write=(action:string,data:Record<string,unknown>)=>call(action,{...data,key:z.uuid().parse(request.headers['idempotency-key'])})
  if(request.method==='GET'){
    const query=Object.fromEntries(url.searchParams)
    if(path==='/finance/access')return call('access',{})
    if(path==='/finance')return call('list',scope.parse(query))
    if(path==='/finance/summary')return call('summary',z.object({from:z.iso.date().optional(),to:z.iso.date().optional()}).strict().parse(query))
    if(path==='/finance/due')return call('due',{})
  }
  if(path==='/finance'&&request.method==='POST')return write('create',movement.parse(await body()))
  if(path==='/finance/budget'&&request.method==='PUT')return write('budget',z.object({projectId:z.uuid(),amount:z.string().regex(/^\d{1,16}(\.\d{1,2})?$/),currency,revision:z.int().min(-1)}).strict().parse(await body()))
  const match=/^\/finance\/([^/]+)$/.exec(path)
  if(match&&request.method==='PUT')return write('edit',{id:z.uuid().parse(match[1]),...movement.extend({status:z.enum(['pending','settled','cancelled']),revision:z.int().nonnegative()}).parse(await body())})
  if(match&&request.method==='PATCH')return write('resolve',{id:z.uuid().parse(match[1]),...z.object({status:z.enum(['settled','cancelled']),settled_on:z.iso.date().nullable(),payment_method:method,revision:z.int().nonnegative()}).strict().parse(await body())})
  throw new ApiError(405,'Operación financiera no permitida.')
}
