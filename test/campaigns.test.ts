import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTextSender } from '../src/campaigns/evolution-send.ts'
import { normalizeWebhook, createWebhook } from '../src/campaigns/webhook.ts'
import { workerCycle } from '../src/campaigns/worker-cycle.ts'
import { campaignInput } from '../src/campaigns/contracts.ts'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'

const config = { url:'https://provider.example',apiKey:'test-key-never-real',instance:'koi-01' }
test('Evolution 2.3.7 sends exact text once and accepts only provider identifiers', async () => {
  let calls = 0
  const send = createTextSender(config, async (url, options) => {
    calls++; assert.equal(String(url),'https://provider.example/message/sendText/koi-01')
    assert.deepEqual(JSON.parse(String(options?.body)),{number:'5493811111111',text:'Hola Ana\n*Prueba*',linkPreview:false})
    assert.equal(options?.redirect,'error')
    return Response.json({key:{id:'message-1'}})
  })
  assert.deepEqual(await send('5493811111111','Hola Ana\n*Prueba*'),{outcome:'accepted',providerId:'message-1'})
  assert.equal(calls,1)
})
test('timeouts and ambiguous provider errors are never retried by sender', async () => {
  for (const response of [() => { throw Error('secret') },() => new Response('secret',{status:500}),() => Response.json({ok:true})]) {
    let calls=0
    const send=createTextSender(config,async()=>{calls++;return response()})
    assert.equal((await send('5493811111111','Hola')).outcome,'unknown');assert.equal(calls,1)
  }
})
test('webhooks normalize receipts, ignore unknown JIDs and strip all private fields', () => {
  const event={event:'messages.update',instance:'koi-01',apikey:'NEVER_STORE',data:{keyId:'a',status:'READ',fromMe:true}}
  const normalized=normalizeWebhook(event,'koi-01')
  assert.equal(normalized[0]?.delivery,'read');assert.equal(JSON.stringify(normalized).includes('NEVER_STORE'),false)
  assert.deepEqual(normalizeWebhook({...event,data:{...event.data,status:'DELIVERY_ACK'}},'koi-01')[0]?.delivery,'delivered')
  const incoming={event:'messages.upsert',instance:'koi-01',data:{key:{id:'b',fromMe:false,remoteJid:'5493811111111@s.whatsapp.net'},message:{conversation:'BAJA'}}}
  assert.equal(normalizeWebhook(incoming,'koi-01')[0]?.phone,'5493811111111')
  incoming.data.key.remoteJid='12345@lid';assert.deepEqual(normalizeWebhook(incoming,'koi-01'),[])
  assert.throws(()=>normalizeWebhook(event,'other'))
})
test('webhook authenticates before reading payload and acknowledges only after durable ingestion', async () => {
  let read=false;let stored=false
  const command:MachineCommand=async<T>()=>{stored=true;return {} as T}
  const receive=createWebhook('s'.repeat(32),'koi-01',command)
  await assert.rejects(receive('invalid',async()=>{read=true;return {}}));assert.equal(read,false)
  await receive('s'.repeat(32),async()=>({event:'connection.update',instance:'koi-01',data:{state:'open'}}));assert.equal(stored,true)
})
test('worker cannot send without a durable begin and never repeats POST after persistence failure', async () => {
  const job={id:'job',campaign_id:'campaign',phone:'5493811111111',message:'Test',lease_token:'lease'}
  let sent=0;let begun=false
  const command:MachineCommand=async<T>(action:string)=>{
    if(action==='claim')return job as T
    if(action==='begin'){begun=true;return job as T}
    if(action==='finish')throw Error('database down')
    return {} as T
  }
  await assert.rejects(workerCycle({command,instance:'koi-01',workerId:'test',enabled:true,signal:new AbortController().signal,connected:async()=>true,send:async()=>{assert.equal(begun,true);sent++;return {outcome:'accepted',providerId:'provider'}}}))
  assert.equal(sent,1)
  const disabled:MachineCommand=async<T>(action:string)=>{assert.equal(action,'tick');return {} as T}
  await workerCycle({command:disabled,instance:'koi-01',workerId:'test',enabled:false,signal:new AbortController().signal,connected:async()=>true,send:async()=>{throw Error('must not send')}})
})
test('campaign configuration rejects arbitrary URLs and invalid hours', () => {
  assert.equal(campaignInput.safeParse({name:'Test',listId:crypto.randomUUID(),template:'Hola',config:{intervalSeconds:30,perMinute:2,perHour:60,perDay:100,timezone:'America/Argentina/Tucuman',days:[1],startMinute:600,endMinute:500,startsAt:null}}).success,false)
})
