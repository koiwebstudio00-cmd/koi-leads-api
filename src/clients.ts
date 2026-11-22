import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { CrmCommand } from './crm.ts'
import { ApiError } from './store.ts'

export async function clientRoute(request:IncomingMessage,path:string,command:CrmCommand,body:()=>Promise<unknown>) {
  const call=async(action:string,data:Record<string,unknown>)=>({status:200,data:await command('client:'+action,data)})
  const write=(action:string,data:Record<string,unknown>)=>call(action,{...data,key:z.uuid().parse(request.headers['idempotency-key'])})
  if(request.method==='GET' && path==='/clients')return call('list',{})
  if(request.method==='GET' && path==='/clients/summary')return call('summary',{})
  const match=/^\/(clients|leads|projects)\/([^/]+)(?:\/(client|clients|projects))?$/.exec(path)
  if(match){
    const id=z.uuid().parse(match[2])
    if(match[1]==='projects' && match[3]==='clients' && request.method==='GET')return call('projectClients',{projectId:id})
    if(match[1]==='leads' && match[3]==='client'){
      if(request.method==='GET')return call('lead',{leadId:id})
      if(request.method==='POST'){
        const selection=z.union([z.object({clientId:z.uuid(),projectId:z.uuid().nullable()}).strict(),z.object({name:z.string().trim().min(1).max(200),projectId:z.uuid().nullable()}).strict()])
        return write('convert',{leadId:id,...selection.parse(await body())})
      }
    }
    if(match[1]==='clients'){
      if(!match[3] && request.method==='GET')return call('detail',{clientId:id})
      if(!match[3] && request.method==='PATCH')return write('edit',{clientId:id,...z.object({status:z.enum(['lead','active','paused','closed']),assigned_to:z.uuid().nullable(),revision:z.int().nonnegative()}).strict().parse(await body())})
      if(match[3]==='projects' && request.method==='POST')return write('contract',{clientId:id,...z.object({projectId:z.uuid()}).strict().parse(await body())})
    }
  }
  throw new ApiError(405,'Operación de cliente no permitida.')
}
