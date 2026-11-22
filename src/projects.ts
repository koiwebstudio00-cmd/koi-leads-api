import { z } from 'zod'
import type { IncomingMessage } from 'node:http'
import type { CrmCommand } from './crm.ts'
import { ApiError } from './store.ts'

const fields = {
  name:z.string().trim().min(1).max(160), type:z.string().trim().min(1).max(80),
  ownership:z.enum(['client','studio','saas']), status:z.enum(['active','paused','done']),
  start_date:z.iso.date().nullable(), deadline:z.iso.date().nullable(),
}
const interest = z.object({reason:z.string().trim().min(1).max(500),assigned_to:z.uuid()}).strict()

export async function projectRoute(request:IncomingMessage,path:string,url:URL,command:CrmCommand,body:()=>Promise<unknown>) {
  const read=(action:string,data:Record<string,unknown>)=>command('project:'+action,data).then(data=>({status:200,data}))
  const write=(action:string,data:Record<string,unknown>)=>read(action,{...data,key:z.uuid().parse(request.headers['idempotency-key'])})
  const match=/^\/projects(?:\/([^/]+))?$/.exec(path)
  if (match) {
    const projectId=match[1] && z.uuid().parse(match[1])
    if(request.method==='GET') return projectId?read('detail',{projectId}):read('list',z.object({search:z.string().trim().max(160).optional()}).strict().parse(Object.fromEntries(url.searchParams)))
    if(!projectId && request.method==='POST') return write('create',z.object(fields).strict().parse(await body()))
    if(projectId && request.method==='PATCH') return write('edit',{projectId,...z.object({...fields,revision:z.int().nonnegative()}).strict().parse(await body())})
  }
  const link=/^\/leads\/([^/]+)\/projects(?:\/([^/]+))?$/.exec(path)
  if(link) {
    const leadId=z.uuid().parse(link[1])
    if(!link[2] && request.method==='GET') return read('interests',{leadId})
    if(link[2]) {
      const ids={leadId,projectId:z.uuid().parse(link[2])}
      if(request.method==='POST') return write('associate',{...ids,...interest.parse(await body())})
      if(request.method==='PATCH') return write('correct',{...ids,...interest.extend({revision:z.uuid()}).parse(await body())})
      if(request.method==='DELETE') return write('remove',{...ids,revision:z.uuid().parse(url.searchParams.get('revision'))})
    }
  }
  throw new ApiError(405,'Operación de proyecto no permitida.')
}
