import type { MachineCommand } from '../campaigns/machine-store.ts'
import { accountRecord,ZernioError,type ZernioClient } from './provider.ts'
import type { InboxTextSender } from './send-provider.ts'
type Job={id:string;lease:string;accountId:string;conversationId:string;channel:'whatsapp'|'instagram';profileId:string;workspaceId:string}
export function createInboxSendCycle(command:MachineCommand,provider:ZernioClient,send:InboxTextSender,expected:{profileId:string;workspaceId:string},signal?:AbortSignal){
 return async()=>{
  if(signal?.aborted)return false
  const job=await command<Job|null>('claim',{})
  if(!job)return false
  try{
   if(job.profileId!==expected.profileId||job.workspaceId!==expected.workspaceId)throw new ZernioError('profile_mismatch')
   const raw=await provider.account(job.accountId)
   if(raw._id!==job.accountId)throw new ZernioError('profile_mismatch')
   const account=accountRecord(raw,expected.profileId)
   if(account.channel!==job.channel||account.state!=='connected')throw new ZernioError('account_disconnected')
  }catch(error){
   const code=error instanceof ZernioError?error.code:'provider_unavailable'
   await command('defer',{id:job.id,lease:job.lease,reason:code,retryAfter:error instanceof ZernioError?error.retryAfter:30,
    terminal:['profile_mismatch','account_disconnected','provider_access_denied','provider_not_found'].includes(code)})
   return true
  }
  if(signal?.aborted){await command('defer',{id:job.id,lease:job.lease,reason:'worker_stopped'});return true}
  const payload=await command<{text:string;requestId:string;expiresAt:string}|null>('begin',{id:job.id,lease:job.lease})
  if(!payload)return true
  const result=await send({...payload,accountId:job.accountId,conversationId:job.conversationId}).catch(()=>({outcome:'unknown' as const,reason:'provider_unconfirmed'}))
  // Retry only recording a result, never the provider POST. A crashed sending lease becomes unknown.
  try{await command('finish',{id:job.id,lease:job.lease,...result})}
  catch{await command('finish',{id:job.id,lease:job.lease,...result})}
  return true
 }
}
