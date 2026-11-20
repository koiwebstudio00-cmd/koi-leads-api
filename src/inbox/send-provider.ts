import { z } from 'zod'
export type SendResult={outcome:'accepted';externalId:string}|{outcome:'failed'|'unknown'|'queued';reason:string;retryAfter?:number}
const accepted=z.object({success:z.literal(true),data:z.object({messageId:z.string().min(1).max(200)})})
export function createInboxTextSender(apiKey:string,fetcher:typeof fetch=fetch){
 return async(input:{accountId:string;conversationId:string;text:string;requestId:string;expiresAt:string}):Promise<SendResult>=>{
  if(!Number.isFinite(Date.parse(input.expiresAt))||Date.now()>=Date.parse(input.expiresAt))return {outcome:'failed',reason:'expired'}
  let response:Response
  try{response=await fetcher('https://zernio.com/api/v1/inbox/conversations/'+encodeURIComponent(input.conversationId)+'/messages',{
   method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':input.requestId},
   body:JSON.stringify({accountId:input.accountId,message:input.text}),redirect:'error',signal:AbortSignal.timeout(15000),
  })}catch{return {outcome:'unknown',reason:'provider_timeout'}}
  if(response.ok){
   const result=accepted.safeParse(await response.json().catch(()=>null))
   return result.success?{outcome:'accepted',externalId:result.data.data.messageId}:{outcome:'unknown',reason:'provider_response_invalid'}
  }
  if(response.status===429){
   const header=response.headers.get('retry-after'),seconds=header&&/^\d+$/.test(header)?Number(header):header?Math.ceil((Date.parse(header)-Date.now())/1000):30
   return {outcome:'queued',reason:'provider_rate_limited',retryAfter:Math.max(5,Math.min(3600,Number.isFinite(seconds)?seconds:30))}
  }
  if([401,403,404,410,412,422,400].includes(response.status)){
   const payload=await response.json().catch(()=>null) as {code?:string;platformError?:{code?:number;subcode?:number}}|null
   const reason=[401,403,412].includes(response.status)?'provider_access_denied':response.status===404?'provider_not_found':
    payload?.platformError?.code===131047||payload?.platformError?.subcode===2018278?'expired':
    payload?.code==='conversation_not_owned'?'conversation_control':'provider_rejected'
   return {outcome:'failed',reason}
  }
  // 409 may mean an idempotent request is still in flight; 5xx can occur after delivery.
  return {outcome:'unknown',reason:'provider_unconfirmed'}
 }
}
export type InboxTextSender=ReturnType<typeof createInboxTextSender>
