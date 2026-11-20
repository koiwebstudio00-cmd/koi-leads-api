import { z } from 'zod'
import { ApiError } from '../store.ts'

type Daily = {date:string;spend:number}
export type AdsRow = {
  adAccountId:string; adId:string; adName:string; campaignId:string; campaignName:string
  currency:string; spend:number|null; daily?:Daily[]
}
export type AdsStatistics = {
  status:'ready'|'partial'|'connection_required'|'unavailable'; rows:AdsRow[]; pending:number
  syncedAt:string|null; message:string|null; accounts?:{id:string;name:string}[]
}
type Input = {fromDate:string;toDate:string;phones:string[];attributedAdIds?:string[];whatsappAccountIds?:string[]}
const record = z.record(z.string(),z.unknown())
type Item = z.infer<typeof record>
function item(value:unknown):Item { return record.safeParse(value).data ?? {} }
function list(value:unknown):Item[] { return z.array(record).parse(value) }
function string(value:unknown) { return typeof value==='string' ? value.trim() : '' }
function amount(value:unknown) {
  if (typeof value!=='number' && !(typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value))) return null
  const number=Number(value)
  return Number.isFinite(number) && number>=0 ? number : null
}
function phone(value:unknown) {
  const raw=string(value)
  return /^\+?[\d ()-]+$/.test(raw) && /^\d{7,15}$/.test(raw.replace(/\D/g,'')) ? raw.replace(/\D/g,'') : ''
}
function linkPhone(value:unknown) {
  try {
    const url=new URL(string(value))
    if (url.protocol!=='https:' && url.protocol!=='http:') return ''
    if (url.hostname==='wa.me') return phone(url.pathname.slice(1))
    if (['api.whatsapp.com','web.whatsapp.com'].includes(url.hostname) && /^\/send\/?$/.test(url.pathname)) return phone(url.searchParams.get('phone'))
  } catch { /* Creative may have no link. */ }
  return ''
}

type Target = 'match'|'other'|'unknown'
// A WhatsApp CTA without its number is ambiguous when several businesses share the ad account.
function destination(ad:Item, set:Item, phones:Set<string>, known:Set<string>, accountIds:Set<string>):Target {
  const creative=item(ad.creative)
  const promoted=item(set.promotedObject ?? set.promoted_object)
  const cta=item(creative.callToAction)
  const target=string(set.destinationType ?? set.destination_type ?? ad.destinationType ?? creative.destinationType).toUpperCase()
  const action=string(cta.type || creative.callToAction || ad.callToAction).toUpperCase()
  if (target.includes('AND_') || target.includes('MULTI')) return 'unknown'
  const deepLink=linkPhone(creative.linkUrl) || linkPhone(creative.link) || linkPhone(item(cta.value).link)
  const number=phone(creative.whatsappPhoneNumber) || phone(ad.whatsappPhoneNumber) || phone(promoted.whatsapp_phone_number)
    || phone(promoted.whatsappPhoneNumber) || deepLink
  if (target && !['WHATSAPP','UNDEFINED','UNKNOWN'].includes(target) && !(target==='WEBSITE' && deepLink)) return 'other'
  if (number && phones.size) return phones.has(number) ? 'match' : 'other'
  if (known.has(string(ad.platformAdId))) return 'match'
  const waId=string(ad.whatsappAccountId ?? creative.whatsappAccountId)
  if (waId && accountIds.has(waId)) return 'match'
  if (target==='WHATSAPP' || number || /WHATSAPP/.test(action)) return 'unknown'
  const website=string(creative.linkUrl ?? creative.link)
  if (website && !/whatsapp\.com|wa\.me/i.test(website) && ['LEARN_MORE','SHOP_NOW','SIGN_UP'].includes(action)) return 'other'
  if (['MESSAGE_PAGE','INSTAGRAM_MESSAGE','VIEW_INSTAGRAM_PROFILE'].includes(action)) return 'other'
  return 'unknown'
}
class ProviderError extends Error {
  readonly code:string
  constructor(_httpStatus:number,code:string) { super('Error consultando Meta Ads'); this.code=code }
}
function missingGrant(error:unknown) {
  return error instanceof ProviderError && ['ads_connection_required','reconnect_required','linked_account_required','insufficient_permissions','missing_permissions'].includes(error.code)
}
function profile(account:Item) { return string(account.profileId) || string(item(account.profileId)._id) }
function pageCount(page:Item, expected:number) {
  if (Number(page.page ?? expected)!==expected) throw new Error('Página de anuncios inesperada')
  const count=Number(page.pages ?? page.totalPages ?? (typeof page.total==='number' && Number(page.limit)>0 ? Math.ceil(page.total/Number(page.limit)) : NaN))
  if (!Number.isInteger(count) || count<0) throw new Error('Paginación de anuncios inválida')
  return count
}
export function createAdsStatistics(apiKey:string,profileId:string,fetcher:typeof fetch=fetch) {
  async function get(path:string,query:Record<string,string>,signal?:AbortSignal) {
    const url=new URL(path,'https://zernio.com/api/v1/')
    url.search=new URLSearchParams(query).toString()
    const response=await fetcher(url,{headers:{Authorization:'Bearer '+apiKey},redirect:'error',
      signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)})
    const data=item(await response.json().catch(()=>null))
    if (!response.ok) throw new ProviderError(response.status,string(data.code))
    return {data,backfill:response.status===202 || data.backfillPending===true}
  }
  async function connect(redirectUrl:string) {
    try {
      const {data}=await get('connect/facebook/ads',{profileId,loginMode:'business',redirect_url:redirectUrl})
      const auth=new URL(string(data.authUrl))
      if (auth.protocol!=='https:' || auth.username || auth.password || auth.port || !['facebook.com','www.facebook.com','m.facebook.com','business.facebook.com','zernio.com','app.zernio.com'].includes(auth.hostname)) throw new Error('URL inválida')
      return auth.href
    } catch { throw new ApiError(502,'No se pudo iniciar la autorización de Meta Ads. Revisá la integración de Zernio.') }
  }
  async function read(input:Input):Promise<AdsStatistics> {
    const phones=new Set(input.phones.map(phone).filter(Boolean)), known=new Set(input.attributedAdIds)
    const whatsappIds=new Set(input.whatsappAccountIds)
    const result:AdsStatistics={status:'ready',rows:[],pending:0,syncedAt:null,message:null,accounts:[]}
    const notes=new Set<string>(), seenAccounts=new Set<string>(), seenAds=new Set<string>()
    const deadline=AbortSignal.timeout(68_000)
    const readPath=(path:string,query:Record<string,string>)=>get(path,query,deadline)
    async function connections(platform:string) {
      const all:Item[]=[], seen=new Set<string>()
      let cursor=''
      do {
        const {data}=await readPath('accounts',{profileId,platform,limit:'100',...(cursor?{cursor}:{})})
        for (const row of list(data.accounts)) if (profile(row)===profileId && row.platform===platform && row.isActive!==false && row.needsReconnection!==true) all.push(row)
        const paging=item(data.pagination)
        cursor=string(paging.nextCursor)
        if (!cursor && paging.hasMore===true || cursor && seen.has(cursor)) throw new Error('Paginación de cuentas incompleta')
        seen.add(cursor)
      } while(cursor)
      return all
    }
    try {
      const owners=await connections('metaads')
      const facebook=(await connections('facebook')).filter(a=>Array.isArray(a.scopeAreas) && a.scopeAreas.includes('ads'))
      owners.push(...facebook)
      if (!owners.length) return {...result,status:'connection_required',message:'Conectá la cuenta publicitaria de Meta para ver la inversión.'}
      if (whatsappIds.size>phones.size) {
        for (const wa of await connections('whatsapp')) {
          if (!whatsappIds.has(string(wa._id))) continue
          const value=phone(item(wa.metadata).displayPhoneNumber) || phone(wa.username)
          if (value) phones.add(value)
        }
      }
      let success=0,denied=false
      for (const owner of owners) {
        const accountId=string(owner._id)
        if (!accountId) throw new Error('Cuenta de conexión inválida')
        try {
          const grants=await readPath('ads/accounts',{accountId,inScopeOnly:'true'})
          for (const acct of list(grants.data.accounts)) {
            const adAccountId=string(acct.id)
            if (!adAccountId || seenAccounts.has(adAccountId) || acct.inScope===false || acct.selected===false) continue
            seenAccounts.add(adAccountId)
            result.accounts!.push({id:adAccountId,name:string(acct.name)||adAccountId})
            const args={accountId,adAccountId,fromDate:input.fromDate,toDate:input.toDate,source:'all'}
            let page=1, pages=1
            try {
              do {
                const tree=await readPath('ads/tree',{...args,page:String(page),limit:'50',depth:'ad',timeIncrement:'1',dailyLevel:'ad'})
                if (tree.backfill) notes.add('Zernio está importando días anteriores. La inversión del período aún es parcial.')
                pages=pageCount(item(tree.data.pagination),page)
                const synced=string(tree.data.syncedAt)
                if (synced && Number.isFinite(Date.parse(synced)) && (!result.syncedAt || Date.parse(synced)<Date.parse(result.syncedAt))) result.syncedAt=synced
                for (const campaign of list(tree.data.campaigns)) {
                  const campaignId=string(campaign.platformCampaignId)
                  if (!campaignId) throw new Error('Campaña sin identificador de Meta')
                  if (campaign.platformAdAccountId && campaign.platformAdAccountId!==adAccountId) throw new Error('Cuenta publicitaria inesperada')
                  for (let set of list(campaign.adSets)) {
                    const setId=string(set.platformAdSetId)
                    let ads=list(set.ads)
                    if (setId && Number(set.adCount)>ads.length) {
                      const expanded=new Map(ads.map(a=>[string(a.platformAdId)||string(a._id),a]))
                      let flatPage=1, end=1
                      do {
                        const flat=await readPath('ads',{...args,adSetId:setId,page:String(flatPage),limit:'100'})
                        if (flat.backfill) notes.add('Zernio está importando días anteriores. La inversión del período aún es parcial.')
                        for (const ad of list(flat.data.ads)) {
                          const id=string(ad.platformAdId)||string(ad._id)
                          expanded.set(id,{...ad,...expanded.get(id)})
                        }
                        end=pageCount(item(flat.data.pagination),flatPage++)
                      } while(flatPage<=end)
                      ads=[...expanded.values()]
                      if (ads.length<Number(set.adCount)) notes.add('Meta todavía no devolvió todos los anuncios del conjunto.')
                    }
                    if (setId && ads.some(ad=>destination(ad,set,phones,known,whatsappIds)==='unknown') && !set.promotedObject && !set.promoted_object) {
                      try {
                        const detail=await readPath('ads/ad-sets/'+encodeURIComponent(setId),{accountId,fields:'destination_type,promoted_object'})
                        set={...set,...item(detail.data.adSet)}
                      } catch { /* An ad may carry the destination itself. */ }
                    }
                    for (let ad of ads) {
                      let target=destination(ad,set,phones,known,whatsappIds)
                      const id=string(ad._id)||string(ad.id)
                      if (target!=='other' && id && (!string(ad.platformAdId) || target==='unknown' && !ad.creative)) {
                        try {
                          const detail=await readPath('ads/'+encodeURIComponent(id),{accountId,fromDate:input.fromDate,toDate:input.toDate})
                          ad={...ad,...item(detail.data.ad),metrics:ad.metrics,daily:ad.daily}
                          target=destination(ad,set,phones,known,whatsappIds)
                        } catch { /* Unresolved destinations are counted below. */ }
                      }
                      const adId=string(ad.platformAdId)
                      const key=adAccountId+'/'+(adId||id)
                      if (seenAds.has(key) || target==='other') continue
                      seenAds.add(key)
                      if (target!=='match' || !adId) { result.pending++;continue }
                      const iso=string(campaign.currency)||string(acct.currency)
                      const currency=/^[A-Z]{3}$/.test(iso)?iso:''
                      const spend=amount(item(ad.metrics).spend)
                      if (!currency || spend===null) notes.add('Faltan importes o monedas para algunos anuncios.')
                      const daily=new Map<string,number>()
                      if (Array.isArray(ad.daily)) for (const point of list(ad.daily)) {
                        const date=string(point.date), value=amount(point.spend ?? item(point.metrics).spend)
                        if (z.iso.date().safeParse(date).success && date>=input.fromDate && date<=input.toDate && value!==null) daily.set(date,value)
                      }
                      result.rows.push({adAccountId,adId,adName:string(ad.name)||adId,campaignId,
                        campaignName:string(campaign.campaignName)||campaignId,currency,spend,
                        daily:[...daily].map(([date,spend])=>({date,spend}))})
                    }
                  }
                }
                page++
              } while(page<=pages)
              success++
            } catch (error) { denied ||= missingGrant(error); notes.add('Meta no pudo completar la lectura de una cuenta publicitaria.') }
          }
        } catch (error) { denied ||= missingGrant(error); notes.add('No se pudo consultar el acceso a una cuenta publicitaria.') }
      }
      if (!success && !result.rows.length && !result.pending) result.status=denied || !notes.size ? 'connection_required' : 'unavailable'
      else if (notes.size || result.pending) result.status='partial'
      if (result.status==='connection_required') notes.add('Autorizá la cuenta publicitaria que paga los anuncios.')
      if (success && !result.syncedAt) {
        notes.add('Zernio todavía no confirmó la fecha de sincronización.')
        result.status='partial'
      }
      result.message=[...notes].join(' ')||null
      return result
    } catch (error) {
      return {...result,status:missingGrant(error)?'connection_required':'unavailable',
        message:'No se pudo consultar Meta Ads. Revisá el acceso al perfil y al módulo de publicidad de Zernio.'}
    }
  }
  return {read,connect}
}
