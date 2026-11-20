import { z } from 'zod'
import type { MachineCommand } from '../campaigns/machine-store.ts'
import { accountRecord, ZernioError, type ZernioClient } from './provider.ts'

const id = z.string().min(1).max(200)
const reactionEvent = z.object({
  event: z.literal('reaction.received'),
  conversation: z.object({platformConversationId:id,participantId:id.nullish()}),
  reaction: z.object({platformMessageId:id, sender:z.object({id}), emoji:z.string().max(100).nullish(),
    action:z.enum(['added','removed']), reactedAt:z.iso.datetime({offset:true})})
})

export function normalizeReaction(payload:unknown) {
  const {conversation, reaction} = reactionEvent.parse(payload)
  if (reaction.action === 'added' && (!reaction.emoji || [...reaction.emoji].length > 32)) {
    throw new ZernioError('invalid_reaction')
  }
  return {
    externalConversationId:conversation.platformConversationId, externalMessageId:reaction.platformMessageId,
    outbound:conversation.participantId ? reaction.sender.id !== conversation.participantId : null,
    senderId:reaction.sender.id, emoji:reaction.action === 'removed' ? null : reaction.emoji!,
    at:reaction.reactedAt,
  }
}

type ReactionJob = {id:string;lease:string;workspaceId:string;profileId:string;channel:'instagram'|'whatsapp';accountId:string}
type ReactionRequest = {accountId:string;conversationId:string;messageId:string;emoji:string|null;expiresAt:string}

export async function sendInboxReaction(apiKey:string, input:ReactionRequest, fetcher:typeof fetch=fetch) {
  if (!(Date.parse(input.expiresAt)>Date.now())) return {outcome:'failed'}
  const path = [input.conversationId,input.messageId].map(encodeURIComponent)
  const url = new URL('https://zernio.com/api/v1/inbox/conversations/'+path[0]+'/messages/'+path[1]+'/reactions')
  const removing = input.emoji===null
  if (removing) url.searchParams.set('accountId',input.accountId)
  try {
    const response = await fetcher(url,{
      method:removing?'DELETE':'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
      body:removing?undefined:JSON.stringify({accountId:input.accountId,emoji:input.emoji}),
      redirect:'error',signal:AbortSignal.timeout(15000),
    })
    if (response.ok) {
      const body = await response.json() as {success?:boolean;platformMessageId?:string}
      return {outcome:body.success && (!body.platformMessageId || body.platformMessageId===input.messageId)?'accepted':'unknown'}
    }
    await response.body?.cancel()
    if (response.status===429) {
      const wait=response.headers.get('retry-after')??''
      const seconds=/^\d+$/.test(wait)?Number(wait):Math.ceil((Date.parse(wait)-Date.now())/1000)
      return {outcome:'queued',retryAfter:Number.isFinite(seconds)?Math.max(5,Math.min(3600,seconds)):30}
    }
    return {outcome:response.status>=500||response.status===408||response.status===409?'unknown':'failed'}
  } catch { return {outcome:'unknown'} }
}

export function createInboxReactionCycle(command:MachineCommand,provider:Pick<ZernioClient,'account'>,apiKey:string,
  expected:{profileId:string;workspaceId:string},signal?:AbortSignal,fetcher:typeof fetch=fetch) {
  return async () => {
    if(signal?.aborted)return false
    const job=await command<ReactionJob|null>('claim',{})
    if(!job)return false
    const binding={id:job.id,lease:job.lease}
    try {
      if(job.profileId!==expected.profileId||job.workspaceId!==expected.workspaceId)throw new ZernioError('profile_mismatch')
      const raw=await provider.account(job.accountId)
      const account=accountRecord(raw,expected.profileId)
      if(raw._id!==job.accountId||account.channel!==job.channel||account.state!=='connected')throw new ZernioError('account_disconnected')
    } catch(error) {
      const terminal=error instanceof ZernioError && ['profile_mismatch','account_disconnected','provider_access_denied','provider_not_found'].includes(error.code)
      await command('defer',{...binding,terminal,retryAfter:error instanceof ZernioError?error.retryAfter:30})
      return true
    }
    if(signal?.aborted){await command('defer',binding);return true}
    const request=await command<ReactionRequest|null>('begin',binding)
    if(!request)return true
    const result=await sendInboxReaction(apiKey,request,fetcher)
    // A retry only records the same provider result. Never repeat an uncertain HTTP write.
    try {await command('finish',{...binding,...result})}
    catch {await command('finish',{...binding,...result})}
    return true
  }
}
