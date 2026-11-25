import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import type { IncomingMessage } from 'node:http'
import { createStatisticsService } from '../src/statistics/service.ts'
import type { UserStore } from '../src/store.ts'
import { seedInbox, inboxFixture as f } from './inbox-fixture.ts'

const db = new PGlite()
const workspaceId = randomUUID(), actorId = randomUUID(), profileId = 'stats-test'
const scope = {workspaceId,actorId,profileId}
const days = {from:'2026-11-01T03:00:00Z',to:'2026-12-01T03:00:00Z'}
const metadata = {referral:{ctwa_clid:'click1',source_type:'ad',source_id:'700'}}
type Report = {rows:{adId:string;campaignId:string|null;consultations:number}[];knownAdIds:string[];undated:number}
async function command<T>(action:string,data:Record<string,unknown>={}) {
  const result = await db.query<{v:T}>('select koi_private.channel_statistics($1,$2) v',[action,JSON.stringify({...scope,...data})])
  return result.rows[0]!.v
}
async function messageEvent(external:string, fields:object) {
  await db.query("insert into koi_private.inbox_events(workspace_id,account_id,external_id,kind,payload) values ($1,$2,$3,'message.received',$4)",[
    workspaceId,f.wa,external,JSON.stringify({message:{platformMessageId:'live'},...fields}),
  ])
}
async function history(fields:object) {
  await db.query('insert into koi_private.inbox_history_context values ($1,$2,$3,$4) on conflict(conversation_id) do update set metadata=excluded.metadata',
    [workspaceId,f.wa,f.waChat,JSON.stringify(fields)])
}

before(async()=>{
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
    create publication supabase_realtime;`)
  const dir = new URL('../supabase/migrations/',import.meta.url)
  const files = (await readdir(dir)).filter(file=>file.endsWith('.sql')).sort()
  const migration = files.find(file=>file.endsWith('_koi_channel_statistics.sql'))!
  for(const file of files.filter(file=>file<migration)) await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.query('insert into auth.users values ($1)',[actorId])
  await db.query("insert into koi_workspaces(id,name) values($1,'Koi')",[workspaceId])
  await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[workspaceId,actorId])
  await db.query("insert into koi_private.inbox_bindings values(session_user,$1,$2,$3,'gateway')",[workspaceId,profileId,actorId])
  await seedInbox(db,workspaceId,actorId)
  await db.query("update koi_private.inbox_messages set sent_at='2026-11-06T18:24:00Z' where account_id=$1 and external_id='live'",[f.wa])
  await messageEvent('already-in-inbox',{metadata})
  for(const file of files.filter(file=>file>=migration)) await db.exec(await readFile(new URL(file,dir),'utf8'))
})
after(()=>db.close())

test('backfills inbound referrals and deduplicates webhook replay and history enrichment',async()=>{
  const before = await command<Report>('attribution',days)
  assert.equal(before.rows[0]?.consultations,1)
  assert.equal(before.rows[0]?.adId,'700')
  assert.equal(before.rows[0]?.campaignId,null)
  await history({ctwa_clid:'click1',adAttribution:{adId:'700',campaignId:'111',name:'Anuncio A',campaignName:'Estudio'}})
  await messageEvent('same-message-new-envelope',{metadata})
  await history({ctwa_clid:'later-click',ctwa_captured_at:'2026-11-18T11:11:00Z',adAttribution:{adId:'999',campaignId:'222'}})
  const result=await command<Report>('attribution',days)
  assert.equal(result.rows.length,1)
  assert.equal(result.rows[0]!.campaignId,'111')
  assert.equal(result.rows[0]!.consultations,1)
  assert.deepEqual(result.knownAdIds,['700'])
  assert.deepEqual((await command<Report>('attribution',{...days,to:'2026-11-06T18:24:00Z'})).rows,[])
})
test('missing dates stay out of the period and a direct inbound is counted once without treating a post as a paid ad',async()=>{
  const id=randomUUID()
  await db.query(`insert into public.koi_inbox_conversations(id,workspace_id,account_id,channel,external_id,identity_id,lead_id)
    select $1,workspace_id,account_id,channel,'stats-other-thread',identity_id,lead_id from public.koi_inbox_conversations where id=$2`,[id,f.waChat])
  await db.query(`insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,status)
    values($1,$2,$3,'direct1','in','','2026-11-09T14:00:00Z','received'),($1,$2,$3,'direct2','in','','2026-11-10T14:00:00Z','received')`,[workspaceId,f.wa,id])
  await db.query("insert into koi_private.inbox_history_context values ($1,$2,$3,$4)",[workspaceId,f.wa,id,JSON.stringify({ctwa_source_type:'post',ctwa_source_id:'not-an-ad'})])
  assert.equal((await command<{unattributed:number}>('attribution',days)).unattributed,1)
  await db.query("update koi_private.inbox_history_context set metadata=$2 where conversation_id=$1",[id,JSON.stringify({ctwa_clid:'click2',ctwa_captured_at:'bad'})])
  const r=await command<Report & {unattributed:number}>('attribution',days)
  assert.equal(r.undated,1)
  assert.equal(r.unattributed,0)
  assert.equal(r.rows.reduce((sum,row)=>sum+row.consultations,0),1)
})

test('gateway statistics rejects mismatched profile/workspace/actor and private tables are not exposed', async()=>{
  for (const data of [{workspaceId:randomUUID()},{profileId:'other'},{actorId:randomUUID()}]) {
    await assert.rejects(command('accounts',data),/scope denied/)
  }
  const access=await db.query<{allowed:boolean}>(`select has_table_privilege('authenticated','koi_private.stats_first_touch','select')
    or has_function_privilege('authenticated','koi_private.channel_statistics(text,jsonb)','execute') as allowed`)
  assert.equal(access.rows[0]?.allowed,false)
})
test('report joins persisted conversations and spend and reuses the scoped source snapshot',async()=>{
  let reads=0
  const service=createStatisticsService({workspaceId,profileId,origin:'https://koi.test',
    command: (action,data)=>command(action,data),
    instagram:async()=>{throw Error('unexpected IG request')},
    ads:{connect:async()=>{throw Error('unexpected write')},read:async(input)=>{
      reads++
      assert.deepEqual(input.attributedAdIds,['700'])
      return {status:'ready',pending:0,message:null,syncedAt:new Date().toISOString(),rows:[{
        adAccountId:'act_1',campaignId:'111',campaignName:'Campaña',adId:'700',adName:'A',currency:'ARS',spend:250,
      }]}
    }}
  })
  const store={membership:{workspace_id:workspaceId,role:'operator'},userId:actorId} as UserStore
  const url=new URL('https://koi.test/api/crm/stats/whatsapp?'+new URLSearchParams(days))
  const report=await service({method:'GET'} as IncomingMessage,url,store) as {groups:{consultations:number;spend:number}[]}
  assert.equal(report.groups[0]?.consultations,1)
  assert.equal(report.groups[0]?.spend,250)
  await service({method:'GET'} as IncomingMessage,url,store)
  assert.equal(reads,1)
})

test('superseded reads cannot overwrite corrected range or daily spend',async()=>{
  const key='whatsapp/dates/account', syncedAt=new Date().toISOString()
  const sample=(spend:number)=>({rows:[{adAccountId:'act_1',campaignId:'c',adId:'a',currency:'ARS',daily:[{date:'2026-11-14',spend}]}]})
  await command('save',{key,syncedAt,channel:'whatsapp',data:sample(234)})
  await command('save',{key,syncedAt:new Date(Date.parse(syncedAt)-3600000).toISOString(),channel:'whatsapp',data:sample(100)})
  const stored=await db.query<{value:number}>('select spend::int as value from koi_private.stats_ad_spend')
  assert.equal(stored.rows[0]?.value,234)
  assert.deepEqual((await command<{data:object}>('load',{key})).data,sample(234))
})
