import { ApiError } from '../store.ts'
import type { InboxReadMedia, MediaLookup } from './read.ts'
import type { ZernioClient } from './provider.ts'

const maximum = 20 * 1024 * 1024
const viewable = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/ogg','audio/mp4','audio/aac','audio/wav','audio/webm','application/pdf'])
export function validateInboxMediaUrl(value:string,accountId:string){
 const url=new URL(value)
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new ApiError(422,'El proveedor devolvió un enlace de archivo no permitido.')
 const authenticated=url.hostname==='zernio.com'&&/^\/api\/v1\/whatsapp\/media\/[A-Za-z0-9_-]+$/.test(url.pathname)
 const cdn=['fbcdn.net','cdninstagram.com','fbsbx.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))
 if(!authenticated&&!cdn)throw new ApiError(422,'Este archivo no está disponible en un origen compatible.')
 if(authenticated)url.searchParams.set('accountId',accountId)
 return {url,authenticated}
}

const validId = (id:unknown):id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)
function allowedSource(value: string | undefined | null, accountId: string) {
  if (!value) return undefined
  try {
    return validateInboxMediaUrl(value, accountId).url.toString()
  } catch {
    return undefined
  }
}
async function resolveSource(provider:ZernioClient,lookup:MediaLookup):Promise<string>{
 if(lookup.channel !== 'whatsapp'){
   if(lookup.sourceUrl && lookup.originalType === 'unsupported_type')return lookup.sourceUrl
   try {return (await provider.attachment(lookup)).url}
   catch(error){if(lookup.sourceUrl)return lookup.sourceUrl;throw error}
 }
 let mediaId=lookup.mediaId
 if(!validId(mediaId) && lookup.sourceUrl){
   const source = allowedSource(lookup.sourceUrl, lookup.accountId)
   if (source) return source
 }
 if(!validId(mediaId)){
   // Older rows did not retain payload.id. Limit history requests for a single preview.
   let cursor:string|undefined
   for(let page=0;page<3;page++){
     const history=await provider.messages(lookup.accountId,lookup.conversationId,cursor)
     const message=history.messages.find(m=>m.accountId===lookup.accountId && m.platform==='whatsapp' && m.id===lookup.messageId)
     if(message){
       const media=message.attachments[lookup.index]
       mediaId=media?.mediaId
       if (!validId(mediaId)) {
         const source = allowedSource(media?.sourceUrl, lookup.accountId)
         if (source) return source
       }
       break
     }
     if(!history.pagination.hasMore||!history.pagination.nextCursor)break
     cursor=history.pagination.nextCursor
   }
 }
 if(!validId(mediaId))throw new ApiError(410,'WhatsApp ya no ofrece el identificador de este archivo.')
 return 'https://zernio.com/api/v1/whatsapp/media/'+encodeURIComponent(mediaId)
}

export function createInboxReadMedia(provider:ZernioClient,apiKey:string,fetcher:typeof fetch=fetch):InboxReadMedia{
 return async lookup=>{
   try{
     let value=await resolveSource(provider,lookup)
     const signal=AbortSignal.timeout(20000)
     for(let redirects=0;redirects<=3;redirects++){
       const {url,authenticated}=validateInboxMediaUrl(value,lookup.accountId)
       const response=await fetcher(url,{signal,redirect:'manual',headers:authenticated?{Authorization:`Bearer ${apiKey}`}:{}})
       if([301,302,303,307,308].includes(response.status)){
         const next=response.headers.get('location');await response.body?.cancel()
         if(!next)throw new ApiError(422,'El archivo ya no está disponible.')
         value=new URL(next,url).toString();continue
       }
       if(!response.ok){
         await response.body?.cancel()
         if([400,404,410].includes(response.status))throw new ApiError(410,'El proveedor ya no tiene disponible este archivo.')
         throw new ApiError(502,'No pudimos acceder al medio en el proveedor. Volvé a intentar.')
       }
       if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw new ApiError(413,'La vista de archivos admite hasta 20 MiB.')}
       if(!response.body)throw new ApiError(422,'El archivo está vacío.')
       const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
       try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum){await reader.cancel();throw new ApiError(413,'La vista de archivos admite hasta 20 MiB.')}chunks.push(part.value)}}finally{reader.releaseLock()}
       if(!size)throw new ApiError(422,'El archivo está vacío.')
       const type=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
       const fallback=lookup.mime?.split(';')[0]?.trim().toLowerCase()??''
       const mime=type && viewable.has(type)?type:(!type||type==='application/octet-stream') && viewable.has(fallback)?fallback:'application/octet-stream'
       return {name:lookup.name.slice(0,250),mime,base64:Buffer.concat(chunks).toString('base64')}
     }
     throw new ApiError(422,'El archivo redirige demasiadas veces.')
   }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(502,'No pudimos consultar el archivo en el proveedor. Volvé a intentar.')}
 }
}
