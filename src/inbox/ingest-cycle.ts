import type { MachineCommand } from '../campaigns/machine-store.ts'
import { accountRecord,normalizeEvent,ZernioError,type ZernioClient } from './provider.ts'

type Delivery={id:string;lease:string;payload:unknown}
type SyncJob={id:string;lease:string;externalAccountId:string;channel:'whatsapp'|'instagram';conversation_key:string;cursor:string|null;updated_since:string}
export function createInboxIngestCycle(command:MachineCommand,provider:ZernioClient,expected:{workspaceId:string;profileId:string},signal?:AbortSignal){
  const cache=new Map<string,{record:ReturnType<typeof accountRecord>;until:number}>()
  async function resolve(id:string,fresh=false){
    const previous=cache.get(id)
    if(!fresh&&previous&&previous.until>Date.now())return previous.record
    const account=await provider.account(id)
    const record=accountRecord(account,expected.profileId)
    if(cache.size>=100)cache.clear()
    cache.set(id,{record,until:Date.now()+60000})
    return record
  }
  async function failed(action:string,item:{id:string;lease:string},error:unknown){
    const code=error instanceof ZernioError?error.code:'ingestion_failed'
    await command(action,{id:item.id,lease:item.lease,code,retryAfter:error instanceof ZernioError?error.retryAfter:30})
    console.error(JSON.stringify({event:'inbox_ingestion_retry',jobId:item.id,code}))
  }
  return async()=>{
    const binding=await command<{workspaceId:string;profileId:string}>('context',{})
    if(binding.workspaceId!==expected.workspaceId||binding.profileId!==expected.profileId)throw new Error('Inbox binding mismatch')
    let worked=false
    // Bound the live batch so a busy account cannot starve history recovery.
    for(let i=0;i<5;i++){
      if(signal?.aborted)return worked
      const item=await command<Delivery|null>('claim_event',{})
      if(!item)break
      worked=true
      try{
        const event=normalizeEvent(item.payload)
        if(!event||(event.profileId&&event.profileId!==expected.profileId)){
          await command('finish_event',{id:item.id,lease:item.lease,ignored:true});continue
        }
        let account:ReturnType<typeof accountRecord>
        try{account=await resolve(event.accountId,event.kind==='account')}
        catch(error){
          if(error instanceof ZernioError&&error.code==='profile_mismatch'){
            await command('finish_event',{id:item.id,lease:item.lease,ignored:true});continue
          }
          if(event.kind==='account'&&(item.payload as {event:string}).event==='account.disconnected'&&error instanceof ZernioError&&error.code==='provider_not_found'){
            const snapshot=await command<ReturnType<typeof accountRecord>|null>('account_snapshot',{externalId:event.accountId})
            if(!snapshot){await command('finish_event',{id:item.id,lease:item.lease,ignored:true});continue}
            cache.delete(event.accountId);account={...snapshot,checkedAt:new Date().toISOString(),state:'disconnected',issue:'account_removed'}
          }else throw error
        }
        if(account.channel!==event.platform)throw new ZernioError('event_account_mismatch')
        await command('finish_event',{id:item.id,lease:item.lease,account,
          ...(event.kind==='reaction'?{reaction:event.reaction}:{}),
          ...(event.kind==='message'?{conversation:event.conversation,message:event.message,metadata:event.metadata}:{})})
      }catch(error){await failed('fail_event',item,error)}
    }
    if(signal?.aborted)return worked
    const job=await command<SyncJob|null>('claim_sync',{})
    if(!job)return worked
    worked=true
    try{
      const account=await resolve(job.externalAccountId)
      if(account.state!=='connected'||account.channel!==job.channel)throw new ZernioError('account_disconnected',300)
      if(!job.conversation_key){
        const page=await provider.conversations(job.externalAccountId,expected.profileId,job.cursor??undefined,job.updated_since)
        if(page.meta?.accountsFailed)throw new ZernioError('history_partial_failure')
        if(page.data.some(c=>c.accountId!==job.externalAccountId||c.platform!==job.channel))throw new ZernioError('history_account_mismatch')
        // Some provider deployments still return a full listing without the documented sync envelope.
        // Keep the old watermark in that mode; advancing it locally could skip late/replayed history.
        const checkpoint=page.sync===undefined?job.updated_since:page.sync.nextUpdatedSince
        if(!page.pagination.hasMore&&!checkpoint)throw new ZernioError('history_checkpoint_missing')
        await command('finish_sync',{id:job.id,lease:job.lease,cursor:page.pagination.hasMore?page.pagination.nextCursor:null,updatedSince:checkpoint,
          conversations:page.data.map(c=>({externalId:c.id,participantId:c.participantId,displayName:c.participantName??'',username:c.whatsappUsername??null,phone:null,metadata:{...(c.metadata??{}),...(c.adAttribution?{adAttribution:c.adAttribution}:{})}}))})
      }else{
        const page=await provider.messages(job.externalAccountId,job.conversation_key,job.cursor??undefined)
        if(page.messages.some(m=>m.accountId!==job.externalAccountId||m.platform!==job.channel))throw new ZernioError('history_account_mismatch')
        await command('finish_sync',{id:job.id,lease:job.lease,cursor:page.pagination.hasMore?page.pagination.nextCursor:null,
          messages:page.messages.map(m=>({externalId:m.id,direction:m.direction==='incoming'?'in':'out',body:m.message??'',sentAt:m.createdAt,historical:true,attachments:m.attachments,quotedExternalId:m.metadata?.quotedMessageId,reactions:m.reactions??undefined,delivery:null}))})
      }
    }catch(error){await failed('fail_sync',job,error)}
    return worked
  }
}
