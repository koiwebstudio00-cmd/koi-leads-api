import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'
import type { UserStore } from '../src/store.ts'
import { createStatisticsService } from '../src/statistics/service.ts'
import { whatsappReport, type Attribution } from '../src/statistics/whatsapp.ts'
import type { AdsStatistics } from '../src/statistics/ads.ts'

const user = {userId:'member',membership:{role:'admin',workspace_id:'workspace'}} as UserStore
const base = 'http://test/api/crm/stats/'
const link = (channel:string,refresh=false) => new URL(base + channel + '?from=2026-11-01T03:00:00Z&to=2026-12-01T03:00:00Z' + (refresh?'&refresh=1':''))
const request = (method='GET') => ({method}) as IncomingMessage
const attribution:Attribution = {
  rows:[{adId:'a1',adName:null,campaignId:null,campaignName:null,consultations:4}],
  knownAdIds:['a1'],undated:0,coverageFrom:'2026-11-01',unattributed:2,
}
const provider:AdsStatistics = {status:'ready',rows:[
  {adAccountId:'account',adId:'a1',adName:'A',campaignId:'c',campaignName:'Estudio',currency:'ARS',spend:10000},
  {adAccountId:'account',adId:'a2',adName:'B',campaignId:'c',campaignName:'Estudio',currency:'ARS',spend:5000},
  {adAccountId:'other',adId:'a3',adName:'C',campaignId:'d',campaignName:'Otra',currency:'USD',spend:10},
], syncedAt:'2026-11-20T00:00:00Z',pending:0,message:null}

test('all discovered ads appear, amounts stay in their currency, unknown amounts stay unknown',()=>{
  const report = whatsappReport(provider,attribution,true)
  assert.equal(report.groups.length,2)
  const ars=report.groups.find(g=>g.currency==='ARS')!
  assert.equal(ars.spend,15000)
  assert.equal(ars.consultations,4)
  assert.equal(ars.spend!/ars.consultations,3750)
  assert.equal(ars.campaigns[0]!.ads[1]!.consultations,0)
  const missing=whatsappReport({...provider,status:'connection_required',rows:[]},attribution,true)
  assert.equal(missing.groups[0]!.spend,null)
  assert.equal(missing.pendingCampaign,4)
  assert.equal(missing.canConnect,true)
})

test('statistics scopes access, caches snapshots, serves dated prior data during an outage and requires admin for OAuth',async()=>{
  let reads=0, offline=false, saved:{at:string;data:AdsStatistics}|null=null
  const db:MachineCommand = async<T>(op:string,data:Record<string,unknown>)=>{
    assert.equal(data.workspaceId,'workspace')
    assert.equal(data.actorId,'member')
    const results:Record<string,unknown>={accounts:[{id:'wa-account',channel:'whatsapp',state:'connected',address:'+54 381 555 1234',name:'Studio'}],attribution,load:saved,save:{}}
    if(op==='save') saved={at:data.syncedAt as string,data:data.data as AdsStatistics}
    return results[op] as T
  }
  const read = createStatisticsService({workspaceId:'workspace',profileId:'profile',origin:'https://studio.test',command:db,
    ads:{connect:async url=>url,read:async(input)=>{
      reads++
      assert.deepEqual(input.phones,['543815551234'])
      assert.equal(input.toDate,'2026-11-30')
      return offline?{...provider,status:'unavailable',rows:[]}:provider
    }},instagram:async()=>{throw Error('unexpected')}
  })
  await assert.rejects(read(request(),link('whatsapp'),{...user,membership:{...user.membership,workspace_id:'x'}}),/otro espacio/)
  await assert.rejects(read(request('POST'),new URL(base+'whatsapp/connect'),{...user,membership:{...user.membership,role:'operator'}}),/administrador/)
  assert.deepEqual(await read(request('POST'),new URL(base+'whatsapp/connect'),user),{authUrl:'https://studio.test/estadisticas?view=whatsapp'})
  await read(request(),link('whatsapp'),user)
  await read(request(),link('whatsapp'),user)
  assert.equal(reads,1)
  if (!saved) throw Error('Snapshot missing')
  ;(saved as {at:string}).at = '2000-01-01T00:00:00Z'
  offline=true
  const stale=await read(request(),link('whatsapp'),user) as ReturnType<typeof whatsappReport>
  assert.equal(stale.state,'partial')
  assert.equal(stale.groups[0]!.spend,15000)
  assert.equal(stale.updatedAt,provider.syncedAt)
  await assert.rejects(read(request(),new URL(base+'whatsapp?from=2026-11-01T04:00:00Z&to=2026-11-03T03:00:00Z'),user),/días completos/)
})
