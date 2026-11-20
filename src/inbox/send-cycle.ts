import type { MachineCommand } from '../campaigns/machine-store.ts'
import { accountRecord,ZernioError,type ZernioClient } from './provider.ts'
import type { InboxTextSender, ReadyMedia, SendInput } from './send-provider.ts'
import type { InboxOutboundFile } from './outbound-media.ts'
import { prepareVoiceForDispatch } from './voice-conversion.ts'
type Job={id:string;lease:string;accountId:string;conversationId:string;channel:'whatsapp'|'instagram';profileId:string;workspaceId:string;hasAttachment?:boolean;richContent?:boolean}
export function createInboxSendCycle(command:MachineCommand,provider:ZernioClient,send:InboxTextSender,expected:{profileId:string;workspaceId:string;richEnabled?:boolean},signal?:AbortSignal){
 return async()=>{
  if(signal?.aborted)return false
  const job=await command<Job|null>('claim',{})
  if(!job)return false
  if((job.richContent||job.hasAttachment)&&!expected.richEnabled){
   await command('defer',{id:job.id,lease:job.lease,terminal:true,reason:'rich_send_disabled'})
   return true
  }
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
  let media: ReadyMedia | undefined
  if(job.hasAttachment && !signal?.aborted){
   const file=await command<InboxOutboundFile|null>('prepare_media',{id:job.id,lease:job.lease})
   if(!file)return true
   let outgoing:InboxOutboundFile
   try{outgoing=await prepareVoiceForDispatch(file,signal)}
   catch{
    await command('defer',{id:job.id,lease:job.lease,reason:signal?.aborted?'worker_stopped':'voice_conversion_failed',terminal:!signal?.aborted})
    return true
   }
   try{
    if(!send.upload)throw new Error('Upload unavailable')
    const url=await send.upload(outgoing)
    media={url,name:outgoing.name,mime:outgoing.mime,voiceNote:outgoing.voiceNote}
   }catch{
    await command('defer',{id:job.id,lease:job.lease,reason:'media_upload_failed',terminal:true})
    return true
   }
  }
  if(signal?.aborted){await command('defer',{id:job.id,lease:job.lease,reason:'worker_stopped'});return true}
  const payload=await command<Omit<SendInput,'accountId'|'conversationId'>|null>('begin',{id:job.id,lease:job.lease})
  if(!payload)return true
  if(payload.humanAgent && !expected.richEnabled){
   await command('finish',{id:job.id,lease:job.lease,outcome:'failed',reason:'rich_send_disabled'})
   return true
  }
  const result=await send({...payload,...(media?{media}:{}),accountId:job.accountId,conversationId:job.conversationId}).catch(()=>({outcome:'unknown' as const,reason:'provider_unconfirmed'}))
  // Retry only recording a result, never the provider POST. A crashed sending lease becomes unknown.
  try{await command('finish',{id:job.id,lease:job.lease,...result})}
  catch{await command('finish',{id:job.id,lease:job.lease,...result})}
  return true
 }
}
