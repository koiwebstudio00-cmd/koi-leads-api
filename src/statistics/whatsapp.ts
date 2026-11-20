import type { AdsStatistics } from './ads.ts'

export type AttributedRow = {
  adId: string | null
  adName: string | null
  campaignId: string | null
  campaignName: string | null
  consultations: number
}
export type Attribution = {
  rows: AttributedRow[]
  knownAdIds: string[]
  coverageFrom: string | null
  unattributed: number
  undated: number
}
type Ad = { id: string; name: string; spend: number | null; consultations: number }
type Campaign = Ad & { ads: Ad[] }

function sumSpend(items: {spend:number|null}[]) {
  if (items.some(item => item.spend === null)) return null
  return Math.round(items.reduce((sum, item) => sum + (item.spend ?? 0), 0) * 1e6) / 1e6
}

export function whatsappReport(source: AdsStatistics, local: Attribution, canConnect: boolean) {
  const currencies = new Map<string | null, Map<string, Campaign>>()
  const ads = new Map<string, Ad>()
  const campaignCurrencies = new Map<string, string|null>()
  let pendingCampaign = 0
  let unmatched = 0

  function campaign(currency: string|null, id: string, name: string) {
    let byId = currencies.get(currency)
    if (!byId) currencies.set(currency, byId = new Map())
    let entry = byId.get(id)
    if (!entry) {
      entry = { id, name, spend:null, consultations:0, ads:[] }
      byId.set(id, entry)
    }
    return entry
  }

  for (const item of source.rows) {
    const entry = campaign(item.currency || null, item.campaignId, item.campaignName || item.campaignId)
    const ad = {id:item.adId, name:item.adName || item.adId, spend:item.spend, consultations:0}
    entry.ads.push(ad)
    ads.set(ad.id, ad)
    campaignCurrencies.set(item.campaignId, item.currency || null)
  }
  for (const row of local.rows) {
    const existing = row.adId ? ads.get(row.adId) : undefined
    if (existing) {
      existing.consultations += row.consultations
      continue
    }
    unmatched += row.consultations
    if (!row.campaignId) pendingCampaign += row.consultations
    const entry = campaign(campaignCurrencies.get(row.campaignId ?? '') ?? null,
      row.campaignId || 'pending', row.campaignName || row.campaignId || 'Campaña pendiente de identificar')
    const adId = row.adId || 'pending'
    const ad = entry.ads.find(item => item.id === adId)
    if (ad) ad.consultations += row.consultations
    else entry.ads.push({id:adId, name:row.adName || row.adId || 'Anuncio pendiente de identificar', spend:null, consultations:row.consultations})
  }
  const groups = Array.from(currencies, ([currency, items]) => {
    const campaigns = Array.from(items.values())
    for (const item of campaigns) {
      item.spend = sumSpend(item.ads)
      item.consultations = item.ads.reduce((total, ad) => total + ad.consultations, 0)
      item.ads.sort((a,b) => (b.spend ?? -1) - (a.spend ?? -1) || a.id.localeCompare(b.id))
    }
    campaigns.sort((a,b) => (b.spend ?? -1) - (a.spend ?? -1) || a.id.localeCompare(b.id))
    return {currency, spend:sumSpend(campaigns), consultations:campaigns.reduce((total,c) => total + c.consultations, 0), campaigns}
  })
  const notes = [source.message]
  if (unmatched && source.rows.length) notes.push('Hay consultas con referencia publicitaria cuya inversión todavía no se pudo vincular.')
  if (source.pending) notes.push(`${source.pending} anuncio(s) con destino pendiente de clasificar.`)
  if (local.undated) notes.push(`${local.undated} consulta(s) con origen publicitario sin fecha verificable, fuera del total del período.`)
  const state = source.status === 'connection_required' ? 'permission_required'
    : source.status === 'ready' && (unmatched || local.undated || source.pending) ? 'partial' : source.status
  return {state, updatedAt:source.syncedAt, coverageFrom:local.coverageFrom, unattributed:local.unattributed,
    pendingCampaign, groups, notice:notes.filter(Boolean).join(' '), canConnect:canConnect && source.status==='connection_required'}
}
