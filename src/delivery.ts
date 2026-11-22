import { z } from 'zod'
import type { IncomingMessage } from 'node:http'
import type { CrmCommand } from './crm.ts'
import { ApiError } from './store.ts'

const scope=z.object({projectId:z.uuid().optional(),clientId:z.uuid().optional()}).strict()
const fields=scope.extend({
  kind:z.enum(['task','milestone','meeting','note','improvement']),title:z.string().trim().min(1).max(240),
  body:z.string().max(16000),status:z.string().max(20),due_date:z.iso.date().nullable(),
  starts_at:z.iso.datetime({offset:true}).nullable(),ends_at:z.iso.datetime({offset:true}).nullable(),
  location:z.string().max(2000).nullable(),projects:z.array(z.uuid()).max(100),
})
export async function deliveryRoute(request:IncomingMessage,path:string,url:URL,command:CrmCommand,body:()=>Promise<unknown>){
  const call=async(action:string,data:Record<string,unknown>)=>({status:200,data:await command('delivery:'+action,data)})
  const write=(action:string,data:Record<string,unknown>)=>call(action,{...data,key:z.uuid().parse(request.headers['idempotency-key'])})
  const query=scope.parse(Object.fromEntries(url.searchParams))
  if(path==='/delivery/agenda'&&request.method==='GET')return call('agenda',{})
  if(path==='/delivery/files'){
    if(request.method==='GET')return call('files',query)
    if(request.method==='POST')return write('upload',{...query,...z.object({name:z.string().trim().min(1).max(255),content:z.base64().min(4).max(6990508)}).strict().parse(await body())})
  }
  const file=/^\/delivery\/files\/([^/]+)$/.exec(path)
  if(file&&request.method==='GET')return call('download',{...query,id:z.uuid().parse(file[1])})
  if(path==='/delivery'){
    if(request.method==='GET')return call('list',query)
    if(request.method==='POST')return write('create',fields.parse(await body()))
  }
  const route=/^\/delivery\/([^/]+)(?:\/(convert|comments))?$/.exec(path)
  if(route){
    const id=z.uuid().parse(route[1])
    if(!route[2]&&request.method==='GET')return call('detail',{id})
    if(!route[2]&&request.method==='PATCH')return write('edit',{id,...fields.extend({revision:z.int().nonnegative()}).parse(await body())})
    if(route[2]==='convert'&&request.method==='POST')return write('convert',{id,...z.object({projectId:z.uuid()}).strict().parse(await body())})
    if(route[2]==='comments'&&request.method==='POST')return write('comment',{id,...z.object({body:z.string().trim().min(1).max(4000)}).strict().parse(await body())})
  }
  throw new ApiError(405,'Operación de entregas no permitida.')
}
