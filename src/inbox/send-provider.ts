import { z } from 'zod'
import type { InboxOutboundFile } from './outbound-media.ts'
import { uploadInboxAttachment } from './outbound-upload.ts'
export type ReadyMedia = { url: string; name: string; mime: string; voiceNote?: boolean }
export type SendInput = {
 accountId: string; conversationId: string; text: string; requestId: string; expiresAt: string
 media?: ReadyMedia; humanAgent?: boolean; replyTo?: string | null; sticker?: 'like_heart' | null
}
export type SendResult={outcome:'accepted';externalId:string}|{outcome:'failed'|'unknown'|'queued';reason:string;retryAfter?:number}
const accepted=z.object({success:z.literal(true),data:z.object({messageId:z.string().min(1).max(200)})})
export function createInboxTextSender(apiKey:string,fetcher:typeof fetch=fetch){
 const send = async(input:SendInput):Promise<SendResult>=>{
  if(!Number.isFinite(Date.parse(input.expiresAt))||Date.now()>=Date.parse(input.expiresAt))return {outcome:'failed',reason:'expired'}
  let response:Response
  try{response=await fetcher('https://zernio.com/api/v1/inbox/conversations/'+encodeURIComponent(input.conversationId)+'/messages',{
   method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':input.requestId},
   body:JSON.stringify({
    accountId:input.accountId,
    ...(input.text && !input.sticker ? {message:input.text} : {}),
    ...(input.media ? {attachmentUrl:input.media.url,attachmentName:input.media.name,
      attachmentType:/^(audio|image|video)\//.test(input.media.mime)?input.media.mime.split('/')[0]:'file',
      ...(input.media.voiceNote?{voiceNote:true}:{})}:{}),
    ...(input.humanAgent ? {messageTag:'HUMAN_AGENT',messagingType:'MESSAGE_TAG'}:{}),
    ...(input.replyTo ? {replyTo:input.replyTo}:{}),
    ...(input.sticker ? {sticker:input.sticker}:{}),
   }),redirect:'error',signal:AbortSignal.timeout(15000),
  })}catch{return {outcome:'unknown',reason:'provider_timeout'}}
  if(response.ok){
   const result=accepted.safeParse(await response.json().catch(()=>null))
   return result.success?{outcome:'accepted',externalId:result.data.data.messageId}:{outcome:'unknown',reason:'provider_response_invalid'}
  }
  if(response.status===429){
   const header=response.headers.get('retry-after'),seconds=header&&/^\d+$/.test(header)?Number(header):header?Math.ceil((Date.parse(header)-Date.now())/1000):30
   return {outcome:'queued',reason:'provider_rate_limited',retryAfter:Math.max(5,Math.min(3600,Number.isFinite(seconds)?seconds:30))}
  }
  if([401,403,404,409,410,412,413,415,422,400].includes(response.status)){
   const payload=await response.json().catch(()=>null) as {code?:string;platformError?:{code?:number;subcode?:number}}|null
   if(response.status===409 && !['conversation_not_owned','not_thread_owner'].includes(payload?.code??''))
    return {outcome:'unknown',reason:'provider_unconfirmed'}
   const reason=[401,403,412].includes(response.status)?'provider_access_denied':response.status===404?'provider_not_found':
    payload?.platformError?.code===131047||payload?.platformError?.subcode===2018278?'expired':
    ['conversation_not_owned','not_thread_owner'].includes(payload?.code??'')?'conversation_control':'provider_rejected'
   return {outcome:'failed',reason}
  }
  // 409 may mean an idempotent request is still in flight; 5xx can occur after delivery.
  return {outcome:'unknown',reason:'provider_unconfirmed'}
 }
 return Object.assign(send,{upload: (file:InboxOutboundFile)=>uploadInboxAttachment(file,apiKey,fetcher)})
}
export type InboxTextSender=((input:SendInput)=>Promise<SendResult>) & {upload?:(file:InboxOutboundFile)=>Promise<string>}
