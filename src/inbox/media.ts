import { ApiError } from '../store.ts'
import type { InboxReadMedia,MediaLookup } from './read.ts'
import type { ZernioClient } from './provider.ts'
const maximum=20*1024*1024
const viewable=new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/ogg','audio/mp4','audio/aac','audio/wav','audio/webm','application/pdf'])
export function validateInboxMediaUrl(value:string,accountId:string){
 const url=new URL(value)
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new ApiError(422,'El proveedor devolvió un enlace de archivo no permitido.')
 const authenticated=url.hostname==='zernio.com'&&/^\/api\/v1\/whatsapp\/media\/[A-Za-z0-9_-]+$/.test(url.pathname)
 const cdn=['fbcdn.net','cdninstagram.com','fbsbx.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))
 if(!authenticated&&!cdn)throw new ApiError(422,'Este archivo no está disponible en un origen compatible.')
 if(authenticated)url.searchParams.set('accountId',accountId)
 return {url,authenticated}
}
export function createInboxReadMedia(provider:ZernioClient,apiKey:string,fetcher:typeof fetch=fetch):InboxReadMedia{
 return async(lookup:MediaLookup)=>{
  try{
   const resolved=await provider.attachment(lookup)
   let value=resolved.url
   const signal=AbortSignal.timeout(20000)
   for(let redirects=0;redirects<=3;redirects++){
    const {url,authenticated}=validateInboxMediaUrl(value,lookup.accountId)
    const response=await fetcher(url,{signal,redirect:'manual',headers:authenticated?{Authorization:`Bearer ${apiKey}`}:{}})
    if([301,302,303,307,308].includes(response.status)){
     const next=response.headers.get('location');await response.body?.cancel()
     if(!next)throw new ApiError(422,'El archivo ya no está disponible.')
     value=new URL(next,url).toString();continue
    }
    if(!response.ok){await response.body?.cancel();throw new ApiError(422,'El proveedor ya no tiene disponible este archivo.')}
    if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw new ApiError(413,'La vista de archivos admite hasta 20 MiB.')}
    if(!response.body)throw new ApiError(422,'El archivo está vacío.')
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum){await reader.cancel();throw new ApiError(413,'La vista de archivos admite hasta 20 MiB.')}chunks.push(part.value)}}finally{reader.releaseLock()}
    if(!size)throw new ApiError(422,'El archivo está vacío.')
    const type=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()??''
    return {name:lookup.name.slice(0,250),mime:viewable.has(type)?type:'application/octet-stream',base64:Buffer.concat(chunks).toString('base64')}
   }
   throw new ApiError(422,'El archivo redirige demasiadas veces.')
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(502,'No pudimos recuperar el archivo de Inbox. Puede haber vencido en el proveedor.')}
 }
}
