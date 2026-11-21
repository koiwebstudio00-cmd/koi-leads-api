import { z } from 'zod'
import { normalizeReaction } from './reactions.ts'

const id=z.string().min(1).max(200)
const date=z.iso.datetime({offset:true})
export const channel=z.enum(['whatsapp','instagram'])
const profile=z.union([id,z.object({_id:id})]).transform(value=>typeof value==='string'?value:value._id)
export const accountSchema=z.object({
  _id:id,profileId:profile,platform:channel,username:z.string().optional(),displayName:z.string().optional(),
  isActive:z.boolean(),needsReconnection:z.boolean().optional(),enabled:z.boolean().optional(),scopeAreas:z.array(z.string()).nullish(),
})
export type ProviderAccount=z.infer<typeof accountSchema>
export const conversationSchema=z.object({
  id,accountId:id,platform:channel,participantId:id,participantName:z.string().nullish(),
  businessScopedUserId:id.optional(),whatsappUsername:z.string().optional(),updatedTime:date,
  metadata:z.record(z.string(),z.unknown()).nullish(),adAttribution:z.record(z.string(),z.unknown()).nullish(),
})
export type ProviderConversation=z.infer<typeof conversationSchema>
const attachment = z.object({
  type: z.string(), originalType: z.string().nullish(), mimeType: z.string().nullish(),
  filename: z.string().nullish(), url: z.string().max(16384).nullish(),
  payload: z.object({id: z.string().max(200).nullish()}).nullish(),
}).transform(({ payload, url, ...media }) => ({
  ...media,
  ...(payload?.id ? { mediaId: payload.id } : {}),
  ...(url ? { sourceUrl: url } : {}),
}))
const messageContext = {
  metadata: z.object({quotedMessageId: id.nullish()}).nullish(),
  reactions: z.array(z.object({emoji:z.string(),fromMe:z.boolean(),reactedAt:date})).nullish(),
}
export const messageSchema=z.object({
  id,conversationId:id,accountId:id,platform:channel,message:z.string().max(10000).nullable(),
  direction:z.enum(['incoming','outgoing']),createdAt:date,attachments:z.array(attachment).nullish().transform(v=>v??[]),
  ...messageContext,
})
export const pagination=z.object({hasMore:z.boolean(),nextCursor:z.string().max(4000).nullable()}).superRefine((p,ctx)=>{
  if(p.hasMore&&!p.nextCursor)ctx.addIssue({code:'custom',message:'Missing next cursor'})
})
export class ZernioError extends Error {
  readonly code:string
  readonly retryAfter:number
  constructor(code:string,retryAfter=30){super('No pudimos completar la consulta a Zernio.');this.code=code;this.retryAfter=retryAfter}
}
export function accountRecord(account:ProviderAccount,profileId:string) {
  if(account.profileId!==profileId)throw new ZernioError('profile_mismatch')
  const missing=account.scopeAreas!=null&&!account.scopeAreas.includes('messaging')
  return {externalId:account._id,profileId,channel:account.platform,checkedAt:new Date().toISOString(),
    label:(account.displayName||account.username||account.platform).slice(0,100),address:account.username?.slice(0,250)||null,
    state:!account.isActive||account.needsReconnection?'disconnected':account.enabled===false||missing?'error':'connected',
    issue:missing?'messaging_permission_missing':account.enabled===false?'account_disabled':account.needsReconnection?'reconnect_required':null}
}
export function createZernioClient(apiKey:string,fetcher:typeof fetch=fetch) {
  async function get<T>(path:string,schema:z.ZodType<T>,query:Record<string,string|undefined>={}) {
    const url=new URL('https://zernio.com/api/v1/'+path)
    for(const [key,value] of Object.entries(query))if(value!==undefined)url.searchParams.set(key,value)
    let response:Response
    try{response=await fetcher(url,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(15000),redirect:'error'})}
    catch{throw new ZernioError('provider_unavailable')}
    if(!response.ok){
      const retry=response.headers.get('retry-after')
      const seconds=retry&&/^\d+$/.test(retry)?Number(retry):retry?Math.ceil((Date.parse(retry)-Date.now())/1000):30
      throw new ZernioError(response.status===429?'provider_rate_limited':response.status===401||response.status===403?'provider_access_denied':response.status===404?'provider_not_found':'provider_unavailable',Math.max(5,Math.min(3600,Number.isFinite(seconds)?seconds:30)))
    }
    try{return schema.parse(await response.json())}catch{throw new ZernioError('provider_contract_invalid')}
  }
  const account = (accountId:string) =>
    get('accounts/'+encodeURIComponent(accountId),z.object({account:accountSchema})).then(v=>v.account)
  async function connect(platform:'whatsapp'|'instagram',profileId:string,redirect:string,reconnect?:string) {
    let scopes: string | undefined = platform === 'instagram' ? 'messaging,analytics' : 'messaging'
    if (platform === 'instagram' && reconnect) {
      const previous = await account(reconnect)
      if (previous._id !== reconnect || previous.profileId !== profileId || previous.platform !== platform) {
        throw new ZernioError('profile_mismatch')
      }
      // A legacy unscoped connection keeps the provider's original full areas.
      scopes = previous.scopeAreas
        ? [...new Set([...previous.scopeAreas, 'messaging', 'analytics'])].join(',')
        : undefined
    }
    return get('connect/'+platform,z.object({authUrl:z.url()}),{
      profileId, redirect_url:redirect, scopes, ...(platform==='whatsapp'?{onboarding:'api'}:{}), reconnectAccountId:reconnect,
    })
  }
  return {
    attachment:(lookup:{accountId:string;conversationId:string;messageId:string;index:number})=>get('inbox/conversations/'+encodeURIComponent(lookup.conversationId)+'/messages/'+encodeURIComponent(lookup.messageId)+'/attachments/'+lookup.index,z.object({url:z.url()}),{accountId:lookup.accountId,format:'json'}),
    account, connect,
    async instagramContact(accountId:string,conversationId:string) {
      const {data}=await get('inbox/conversations/'+encodeURIComponent(conversationId),z.object({
        data:z.object({id,accountId:id,platform:z.literal('instagram'),participantId:id,
          instagramProfile:z.object({username:z.string().nullish()}).nullish()}),
      }),{accountId})
      if(data.id!==conversationId || data.accountId!==accountId)throw new ZernioError('profile_mismatch')
      if(data.instagramProfile?.username)return data.instagramProfile.username
      const participant=await get('accounts/'+encodeURIComponent(accountId)+'/follow-status/'+encodeURIComponent(data.participantId),
        z.object({userId:id,accountId:id,username:z.string().nullish()}))
      if(participant.accountId!==accountId || participant.userId!==data.participantId)throw new ZernioError('profile_mismatch')
      return participant.username??null
    },
    conversations:(accountId:string,profileId:string,cursor?:string,updatedSince?:string)=>get('inbox/conversations',z.object({
      data:z.array(conversationSchema),pagination,sync:z.object({nextUpdatedSince:date.nullable()}).optional(),meta:z.object({accountsFailed:z.number().default(0)}).optional(),
    }),{accountId,profileId,limit:'100',cursor,updatedSince,sortOrder:'desc'}),
    messages:(accountId:string,conversationId:string,cursor?:string)=>get('inbox/conversations/'+encodeURIComponent(conversationId)+'/messages',z.object({messages:z.array(messageSchema),pagination}),{accountId,limit:'100',sortOrder:'desc',cursor}),
  }
}
export type ZernioClient=ReturnType<typeof createZernioClient>

export const envelope=z.object({id,event:z.string().min(1).max(100),timestamp:date,test:z.boolean().optional()}).passthrough()
const webhookMessage=z.object({platformMessageId:id,platform:channel,direction:z.enum(['incoming','outgoing']),
  text:z.string().max(10000).nullable(),sentAt:date,attachments:z.array(attachment).nullish().transform(v=>v??[]),
  ...messageContext,
  sender:z.object({id,name:z.string().optional(),username:z.string().optional(),phoneNumber:z.string().nullish(),businessScopedUserId:id.optional()})})
export function normalizeEvent(payload:unknown){
  const base=envelope.parse(payload)
  if(base.test||!['message.received','message.sent','message.delivered','message.read','message.failed','account.connected','account.disconnected','reaction.received'].includes(base.event))return null
  const parsed=z.object({account:z.object({accountId:id.optional(),id:id.optional(),profileId:id.optional(),platform:z.string()})}).parse(payload)
  const parsedChannel=channel.safeParse(parsed.account.platform)
  if(!parsedChannel.success)return null
  const platform=parsedChannel.data
  const accountId=parsed.account.accountId??parsed.account.id
  if(!accountId)throw new ZernioError('event_account_missing')
  if(base.event==='reaction.received')return {kind:'reaction' as const,accountId,profileId:parsed.account.profileId,platform,reaction:normalizeReaction(payload)}
  if(base.event.startsWith('account.'))return {kind:'account' as const,accountId,profileId:parsed.account.profileId,platform}
  const event=z.object({message:webhookMessage,conversation:z.object({platformConversationId:id,participantId:id.optional(),participantName:z.string().optional(),participantUsername:z.string().optional()}),
    metadata:z.record(z.string(),z.unknown()).nullish()}).parse(payload)
  if(event.message.platform!==platform)throw new ZernioError('event_account_mismatch')
  const m=event.message, c=event.conversation
  const incoming=m.direction==='incoming'
  if((base.event==='message.received'&&!incoming)||(base.event!=='message.received'&&incoming))throw new ZernioError('event_direction_invalid')
  const participant=c.participantId||(incoming?m.sender.id:undefined)
  if(!participant)throw new ZernioError('event_participant_missing')
  return {kind:'message' as const,accountId,profileId:parsed.account.profileId,platform,
    conversation:{externalId:c.platformConversationId,participantId:participant,displayName:c.participantName||(incoming?m.sender.name:'')||'',username:c.participantUsername||(incoming?m.sender.username:null)||null,
      phone:incoming&&platform==='whatsapp'&&m.sender.phoneNumber?m.sender.phoneNumber.replace(/^\+/,''):null},
    message:{externalId:m.platformMessageId,direction:incoming?'in':'out',body:m.text??'',sentAt:m.sentAt,
      historical:false,attachments:m.attachments,quotedExternalId:m.metadata?.quotedMessageId??event.metadata?.quotedMessageId,
      reactions:m.reactions??undefined,delivery:base.event==='message.read'?'read':base.event==='message.delivered'?'delivered':base.event==='message.failed'?'error':incoming?null:'sent'},
    metadata:event.metadata??{},timestamp:base.timestamp}
}
