import { createHash,createHmac,timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { ApiError } from '../store.ts'
import type { MachineCommand } from '../campaigns/machine-store.ts'
import { envelope } from './provider.ts'

export function createInboxWebhook(secret:string,command:MachineCommand){
  return async(headers:IncomingHttpHeaders,raw:Buffer)=>{
    const signature=headers['x-zernio-signature']
    if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),createHmac('sha256',secret).update(raw).digest()))throw new ApiError(401,'Firma de webhook inválida.')
    let payload:unknown
    try{payload=JSON.parse(raw.toString('utf8'))}catch{throw new ApiError(400,'Evento inválido.')}
    const checked=envelope.safeParse(payload)
    if(!checked.success)throw new ApiError(422,'Evento inválido.')
    if((headers['x-zernio-event-id']&&headers['x-zernio-event-id']!==checked.data.id)||(headers['x-zernio-event']&&headers['x-zernio-event']!==checked.data.event))throw new ApiError(400,'Identidad de evento inválida.')
    // ACK only after durable storage. No provider calls or message processing here.
    await command('enqueue',{externalId:checked.data.id,kind:checked.data.event,hash:createHash('sha256').update(raw).digest('hex'),payload})
    return {received:true}
  }
}
