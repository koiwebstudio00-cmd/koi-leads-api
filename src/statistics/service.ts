import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { MachineCommand } from '../campaigns/machine-store.ts'
import { ApiError, type UserStore } from '../store.ts'
import type { createAdsStatistics, AdsStatistics } from './ads.ts'
import type { createInstagramStatistics, InstagramStatistics } from './instagram.ts'
import { whatsappReport, type Attribution } from './whatsapp.ts'

type Account = {id:string; name:string; channel:'instagram'|'whatsapp'; address:string|null; state:string}
type Options = {
  command: MachineCommand; workspaceId:string; profileId:string; origin:string
  ads:ReturnType<typeof createAdsStatistics>; instagram:ReturnType<typeof createInstagramStatistics>
}
const query = z.object({
  from:z.iso.datetime({offset:true}), to:z.iso.datetime({offset:true}), refresh:z.literal('1').optional(),
}).strict()
const day = 86_400_000
const localDay = (ms:number) => new Date(ms - 3 * 3600_000).toISOString().slice(0,10)
const igNotes = {
  permission:'La cuenta necesita autorizar las estadísticas de Instagram.',
  provider:'Instagram no pudo completar la consulta.', plan:'El plan de Zernio necesita acceso a analíticas.',
  range:'Instagram limita el alcance único para este período.', coverage:'Algunas métricas no tienen historial completo.',
}
export type StatisticsService = (req:IncomingMessage,url:URL,store:UserStore)=>Promise<unknown>

export function createStatisticsService(options:Options):StatisticsService {
  const pending = new Map<string, Promise<unknown>>()
  return async (req,url,store) => {
    if (store.membership.workspace_id !== options.workspaceId) throw new ApiError(403,'Esta integración pertenece a otro espacio.')
    const isAdmin = store.membership.role === 'admin'
    const scope = {actorId:store.userId, workspaceId:options.workspaceId, profileId:options.profileId}
    const command:MachineCommand = (action,data) => options.command(action,{...data,...scope})
    const channel = url.pathname.slice('/api/crm/stats/'.length)
    if (channel === 'whatsapp/connect' && req.method === 'POST') {
      if (!isAdmin) throw new ApiError(403,'Solo un administrador puede conectar Meta Ads.')
      await command('accounts',{})
      return {authUrl:await options.ads.connect(new URL('/estadisticas?view=whatsapp',options.origin).href)}
    }
    if (req.method !== 'GET') throw new ApiError(405,'Método no permitido.')
    if (channel !== 'whatsapp' && channel !== 'instagram') throw new ApiError(404,'Informe desconocido.')
    const dates = query.parse(Object.fromEntries(url.searchParams))
    const start = Date.parse(dates.from), end = Date.parse(dates.to)
    if (end <= start || end-start > 366*day) throw new ApiError(422,'Elegí un período de hasta 366 días.')
    if ((start-3*3600_000)%day !== 0 || (end-3*3600_000)%day !== 0) {
      throw new ApiError(422,'Elegí días completos según el horario de Argentina.')
    }
    const from = localDay(start), to = localDay(end-1)
    if (Date.parse(to)-Date.parse(from)>365*day) throw new ApiError(422,'Elegí un período de hasta 366 días.')
    const accounts = (await command<Account[]>('accounts',{})).filter(a=>a.channel===channel)
    const active = accounts.filter(a=>a.state==='connected')

    async function cached<T>(inputs:unknown, fetchData:()=>Promise<T>, status:(data:T)=>'save'|'partial'|'temporary'|'other') {
      const signature = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
      const key = [channel,from,to,signature].join('/')
      const previous = await command<{at:string;data:T}|null>('load',{key})
      const age = previous ? Date.now()-Date.parse(previous.at) : Infinity
      if (previous && age>=0 && age < (dates.refresh ? 15_000 : 5*60_000)) return {data:previous.data,stale:false}
      const inFlight = pending.get(key)
      if (inFlight) return inFlight as Promise<{data:T;stale:boolean}>
      if (pending.size >= 12) {
        if (previous) return {data:previous.data,stale:true}
        throw new ApiError(429,'Hay varias estadísticas actualizándose. Volvé a intentar en unos segundos.')
      }
      const syncedAt = new Date().toISOString()
      const run = (async () => {
        const data = await fetchData()
        const outcome = status(data)
        if (outcome==='temporary' && previous) return {data:previous.data,stale:true}
        if (outcome==='save' || outcome==='partial') {
          await command('save',{key,data,syncedAt,channel,keepPrevious:outcome==='partial' && !!previous && status(previous.data)==='save'})
        }
        return {data,stale:false}
      })()
      pending.set(key,run)
      try {return await run} finally {pending.delete(key)}
    }

    if (channel==='instagram') {
      const account = active[0]
      if (!account) return {state:accounts.length?'permission_required':'not_connected', accountName:accounts[0]?.name??null,
        reach:null,views:null,interactions:null,followers:null,followersChange:null,updatedAt:null,coverageFrom:null,
        canConnect:isAdmin,notice:'Conectá una cuenta profesional de Instagram para consultar sus estadísticas.'}
      const {data,stale} = await cached<InstagramStatistics>(account.id,()=>options.instagram({accountId:account.id,from,to}),
        result => result.status==='unavailable' && result.issue==='provider' ? 'temporary'
          : result.status==='ok' || result.status==='partial' && result.issue!=='provider' ? 'save' : 'other')
      return {state:stale?'partial':data.status==='ok'?'ready':data.status,accountName:account.name,reach:data.reach,
        views:data.views,interactions:data.interactions,followers:data.followers,followersChange:data.followerChange,
        followersAsOf:data.followersAsOf,updatedAt:data.status==='unavailable'||data.status==='permission_required'?null:data.updatedAt,
        coverageFrom:null,followerCoverage:data.followerCoverage,canConnect:isAdmin,
        notice:stale?'Instagram no respondió. Mostramos la última consulta guardada.':data.issue?igNotes[data.issue]:''}
    }

    const local = await command<Attribution>('attribution',{from:dates.from,to:dates.to})
    if (!accounts.length) {
      const empty:AdsStatistics = {status:'unavailable',rows:[],pending:0,message:'Conectá el número de WhatsApp del inbox.',syncedAt:null}
      return {...whatsappReport(empty,local,false),state:'not_connected'}
    }
    const phones = accounts.flatMap(a => {
      const address = a.address?.trim()
      if (address && /^\+?[\d ()-]{7,24}$/.test(address)) return [address.replace(/\D/g,'')]
      const phone = a.name.match(/\+[\d ()-]{7,23}/)?.[0]
      return phone ? [phone.replace(/\D/g,'')] : []
    }).sort()
    const whatsappAccountIds = accounts.map(a=>a.id).sort()
    const attributedAdIds = local.knownAdIds.sort()
    const input = {fromDate:from,toDate:to,phones,whatsappAccountIds,attributedAdIds}
    const {data,stale} = await cached<AdsStatistics>([phones,whatsappAccountIds,attributedAdIds],()=>options.ads.read(input),
      result=>result.status==='ready'?'save':result.status==='partial'?'partial':result.status==='unavailable'?'temporary':'other')
    const report = whatsappReport(data,local,isAdmin)
    if (stale) {
      report.state='partial'
      report.notice=['Meta Ads no respondió. Mostramos la última inversión guardada.',report.notice].filter(Boolean).join(' ')
    }
    const measuredAccounts = new Map(data.rows.map(row => [row.adAccountId, {id:row.adAccountId,name:row.adAccountId}]))
    for (const account of data.accounts ?? []) measuredAccounts.set(account.id,{id:account.id,name:account.name})
    return {...report,accounts:[...measuredAccounts.values()],
      spendPeriod:data.syncedAt && (data.status==='ready' || data.status==='partial') ? {from,to} : null}
  }
}
