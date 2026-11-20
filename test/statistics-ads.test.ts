import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdsStatistics } from '../src/statistics/ads.ts'

const profile = '632000000000000000000001'
const connection = '632000000000000000000002'
const account = 'act_123450'
const phone = '543815551234'
const period = {fromDate:'2026-11-01', toDate:'2026-11-20', phones:[phone]}
const syncedAt = '2026-11-20T14:00:00.000Z'

function ad(id:string, name:string, spend:number, linkUrl:string) {
  return {
    _id:id.padStart(24, '0'), platformAdId:id, name, platform:'facebook', status:'paused',
    platformAdAccountId:account, creative:{linkUrl,callToAction:linkUrl.includes('wa.me')?'WHATSAPP_MESSAGE':'LEARN_MORE'},
    metrics:{spend}, daily:[{date:'2026-11-10',spend}],
  }
}

type Ad = ReturnType<typeof ad>
function campaign(id:string, ads:Ad[], adCount=ads.length) {
  return {
    platformCampaignId:id, campaignName:'Campaña '+id, platform:'facebook', currency:'ARS', adCount,
    adSets:[{platformAdSetId:id+'0',adSetName:'Conjunto',adCount,ads}],
  }
}

type MockOptions = {
  pages?:ReturnType<typeof campaign>[][]
  accounts?:{id:string;name:string;currency:string;selected:boolean}[]
  treeByAccount?:Record<string,ReturnType<typeof campaign>[][]>
  flatPages?:Ad[][]
  detail?:Ad
  pending?:boolean
  failAt?:string
  noConnection?:boolean
  authUrl?:string
}

function fixture(options:MockOptions={}) {
  const calls:URL[] = []
  const pages=options.pages??[[]]
  const allAds=pages.flatMap(page=>page.flatMap(c=>c.adSets.flatMap(s=>s.ads)))
  const fetcher:typeof fetch=async(input, init)=>{
    const url=new URL(input instanceof Request ? input.url : String(input))
    calls.push(url)
    assert.equal(url.origin,'https://zernio.com')
    assert.equal(init?.method??'GET','GET')
    assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-key')
    const path=url.pathname.replace('/api/v1/','')
    if (path===options.failAt) return Response.json({error:'synthetic service failure'},{status:503})
    if (path==='connect/facebook/ads') {
      return Response.json({authUrl:options.authUrl??'https://www.facebook.com/v23.0/dialog/oauth?state=opaque'})
    }
    if (path==='accounts') {
      const accounts=options.noConnection?[]:[{_id:connection,profileId:profile,platform:'metaads',
        username:'Estudio',isActive:true,needsReconnection:false,scopeAreas:['ads']}]
      return Response.json({accounts,pagination:{nextCursor:null,hasMore:false}})
    }
    if (path==='ads/accounts') return Response.json({accounts:options.accounts??[{id:account,name:'Estudio',currency:'ARS',selected:true}]})
    if (path==='ads/tree') {
      const page=Number(url.searchParams.get('page')??'1')
      const accountPages=options.treeByAccount?.[url.searchParams.get('adAccountId')??'']??pages
      return Response.json({campaigns:accountPages[page-1]??[],syncedAt,backfillPending:!!options.pending,
        pagination:{page,pages:accountPages.length,total:accountPages.flat().length,limit:1}},
        {status:options.pending?202:200})
    }
    if (path==='ads' && options.flatPages) {
      const page=Number(url.searchParams.get('page')??'1')
      return Response.json({ads:options.flatPages[page-1]??[],syncedAt,
        pagination:{page,pages:options.flatPages.length,total:options.flatPages.flat().length,limit:100}})
    }
    if (path.startsWith('ads/ad-sets/')) return Response.json({adSet:{id:path.split('/').pop()}})
    const found=allAds.find(a=>path==='ads/'+a._id || path==='ads/'+a.platformAdId)
    if (found) return Response.json({ad:options.detail??found})
    throw Error('Solicitud inesperada: '+path)
  }
  return {api:createAdsStatistics('synthetic-key',profile,fetcher),calls}
}

test('discovers ads across campaign pages and uses only the monitored WhatsApp number or observed CTWA referral',async()=>{
  const first=ad('101','Pausado',10000,'https://wa.me/'+phone)
  const unrelated=ad('102','Otro número',700,'https://wa.me/5491112345678')
  const website=ad('103','Sitio',450,'https://example.com')
  const known=ad('201','Por referencia',5,'https://api.whatsapp.com/send')
  const empty=ad('202','Sin consultas',0,'https://wa.me/'+phone)
  const {api,calls}=fixture({pages:[[campaign('10',[first,unrelated,website])],[campaign('20',[known,empty])]]})
  const result=await api.read({...period,attributedAdIds:['201']})
  assert.deepEqual(result.rows.map(r=>r.adId).sort(),['101','201','202'])
  const row=result.rows.find(r=>r.adId==='101')!
  assert.equal(row.adAccountId,account)
  assert.equal(row.campaignId,'10')
  assert.equal(row.campaignName,'Campaña 10')
  assert.equal(row.adName,'Pausado')
  assert.equal(row.spend,10000)
  assert.equal(row.currency,'ARS')
  assert.deepEqual(row.daily,[{date:'2026-11-10',spend:10000}])
  assert.equal(result.rows.find(r=>r.adId==='202')?.spend,0)
  const trees=calls.filter(c=>c.pathname.endsWith('/ads/tree'))
  assert.equal(trees.length,2)
  assert.ok(trees.every(c=>c.searchParams.get('accountId')===connection &&
    c.searchParams.get('adAccountId')===account && c.searchParams.get('fromDate')===period.fromDate &&
    c.searchParams.get('toDate')===period.toDate && c.searchParams.get('dailyLevel')==='ad'))
  assert.ok(calls.filter(c=>c.pathname.endsWith('/v1/accounts')).every(c=>c.searchParams.get('profileId')===profile))
})

test('flags incomplete provider coverage and missing authorization',async()=>{
  const verified=ad('301','WhatsApp',250,'https://wa.me/'+phone)
  const incomplete=await fixture({pages:[[campaign('30',[verified])]],pending:true}).api.read(period)
  assert.equal(incomplete.status,'partial')
  const truncated=await fixture({pages:[[campaign('30',[verified],110)]]}).api.read(period)
  assert.notEqual(truncated.status,'ready')
  const noAccess=await fixture({noConnection:true}).api.read(period)
  assert.equal(noAccess.status,'connection_required')
  const offline=await fixture({failAt:'ads/tree'}).api.read(period)
  assert.notEqual(offline.status,'ready')
  assert.equal(offline.rows.length,0)
})

test('supplements a capped tree from paginated ads and keeps currencies and account scope intact',async()=>{
  const usd='act_345670', denied='act_999999'
  const hundred=Array.from({length:100},(_,i)=>ad(String(1000+i),'Ad '+i,10,'https://wa.me/'+phone))
  const tail=ad('1100','Otro anuncio pausado',123,'https://wa.me/'+phone)
  const dollarAd=ad('2100','Otro presupuesto',12.5,'https://wa.me/'+phone)
  const {api,calls}=fixture({
    accounts:[
      {id:account,name:'ARS',currency:'ARS',selected:true},
      {id:usd,name:'USD',currency:'USD',selected:true},
      {id:denied,name:'Fuera de alcance',currency:'USD',selected:false},
    ],
    treeByAccount:{
      [account]:[[campaign('10',hundred,101)]],
      [usd]:[[{...campaign('20',[dollarAd]),currency:'USD'}]],
    },
    flatPages:[hundred,[tail]],
  })
  const result=await api.read(period)
  assert.equal(result.status,'ready')
  assert.equal(result.rows.length,102)
  assert.equal(result.rows.filter(r=>r.currency==='ARS').reduce((n,r)=>n+r.spend!,0),1123)
  assert.equal(result.rows.find(r=>r.adAccountId===usd)?.spend,12.5)
  assert.deepEqual(result.accounts?.map(a=>a.id).sort(),[account,usd])
  assert.equal(calls.some(c=>c.searchParams.get('adAccountId')===denied),false)
  assert.equal(calls.filter(c=>c.pathname==='/api/v1/ads' && c.searchParams.get('adSetId')==='100').length,2)
})

test('ad metadata enrichment keeps range-specific spend and ambiguous WhatsApp destinations stay pending',async()=>{
  const full=ad('503','Anuncio sincronizado',125,'https://wa.me/'+phone)
  const missingPlatformId={...full,platformAdId:''}
  const ambiguous=ad('504','WhatsApp sin número',35,'https://api.whatsapp.com/send')
  ambiguous.creative.callToAction='WHATSAPP_MESSAGE'
  const {api}=fixture({pages:[[campaign('50',[missingPlatformId,ambiguous])]],
    detail:{...full,metrics:{spend:9999}}})
  const result=await api.read(period)
  assert.equal(result.status,'partial')
  assert.equal(result.pending,1)
  assert.deepEqual(result.rows.map(r=>[r.adId,r.spend]),[['503',125]])
})

test('connect obtains the Meta business authorization URL without exposing credentials',async()=>{
  const redirect='https://leads.example.test/estadisticas?view=whatsapp'
  const {api,calls}=fixture()
  const url=await api.connect(redirect)
  assert.equal(new URL(url).hostname,'www.facebook.com')
  assert.equal(calls[0]?.searchParams.get('profileId'),profile)
  assert.equal(calls[0]?.searchParams.get('redirect_url'),redirect)
  assert.equal(calls[0]?.searchParams.get('loginMode'),'business')
  await assert.rejects(fixture({authUrl:'https://www.facebook.com.example.test/auth'}).api.connect(redirect))
})
