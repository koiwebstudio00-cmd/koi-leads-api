import { once } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWhatsAppManager } from '../src/whatsapp.ts'
import { ApiError, type UserStore } from '../src/store.ts'
const workspace='11111111-1111-4111-8111-111111111111', id='22222222-2222-4222-8222-222222222222'
const config={url:'https://evolution.test',apiKey:'secret-do-not-expose',workspaceId:workspace,instanceName:'koi-01'}
const record={id,label:'Comercial',instance_name:'koi-22222222222242228222222222222222',request_id:id}
function fixture(role='admin',w=workspace){return {membership:{workspace_id:w,role},whatsapp:{list:async()=>[record],get:async(key:string)=>{if(key!==id)throw new ApiError(404,'Missing');return record},reserve:async()=>record,assertIdle:async()=>{}}} as unknown as UserStore}
test('management rejects operators and foreign workspaces before contacting Evolution',async()=>{
 let calls=0;const manager=createWhatsAppManager(config,{fetch:async()=>{calls++;return Response.json({})}})
 await assert.rejects(manager.create(fixture('operator'),'x',id),e=>e instanceof ApiError&&e.status===403)
 await assert.rejects(manager.action(fixture('operator'),'primary','connect'),e=>e instanceof ApiError&&e.status===403)
 await assert.rejects(manager.list(fixture('admin',id)),e=>e instanceof ApiError&&e.status===403)
 await assert.rejects(manager.action(fixture(),workspace,'connect'),e=>e instanceof ApiError&&e.status===404)
 assert.equal(calls,0)
})
test('create reserves immutable registry identity; retry reconciles existing provider instance without duplicates',async()=>{
 let exists=false,creates=0
 const manager=createWhatsAppManager(config,{fetch:async(url,init)=>{
  assert.equal(new Headers(init?.headers).get('apikey'),config.apiKey)
  if(String(url).endsWith('/create')){const body=JSON.parse(String(init?.body));assert.equal(body.instanceName,record.instance_name);assert.equal(body.integration,'WHATSAPP-BAILEYS');assert.equal(body.qrcode,false);creates++;exists=true;return Response.json({hash:{apikey:config.apiKey}})}
  return exists?Response.json({instance:{instanceName:record.instance_name,state:'close'}}):Response.json({}, {status:404})
 }})
 const a=await manager.create(fixture(),'Comercial',id);await manager.create(fixture(),'Comercial',id)
 assert.equal(a.instanceName,record.instance_name);assert.equal(creates,1);assert(!JSON.stringify(a).includes(config.apiKey))
})
test('QR output strips tokens and accepts only bounded PNG data; management uses exact provider methods',async()=>{
 let raw:Record<string,unknown>={base64:'data:image/png;base64,aGVsbG8=',code:'PRIVATE',apikey:config.apiKey}
 const calls:string[]=[];const manager=createWhatsAppManager(config,{fetch:async(url,init)=>{calls.push(`${init?.method} ${url}`);return Response.json(raw)}})
 assert.equal((await manager.action(fixture(),'primary','connect')).qr,'data:image/png;base64,aGVsbG8=')
 raw={base64:'https://evil.test/qr',apikey:config.apiKey};assert.equal((await manager.action(fixture(),'primary','connect')).qr,null)
 raw={};await manager.action(fixture(),'primary','disconnect');await manager.action(fixture(),'primary','restart')
 assert(calls.includes('DELETE https://evolution.test/instance/logout/koi-01'));assert(calls.includes('POST https://evolution.test/instance/restart/koi-01'))
})
test('active campaigns block disconnect/restart; transport errors and provider errors never expose secrets',async()=>{
 let calls=0;const store=fixture();store.whatsapp!.assertIdle=async()=>{throw new ApiError(409,'Active campaign')}
 const manager=createWhatsAppManager(config,{fetch:async()=>{calls++;throw new Error(config.apiKey)}})
 await assert.rejects(manager.action(store,'primary','disconnect'),e=>e instanceof ApiError&&e.status===409);assert.equal(calls,0)
 await assert.rejects(manager.action(fixture(),'primary','connect'),e=>e instanceof ApiError&&!e.message.includes(config.apiKey))
 const failed=createWhatsAppManager(config,{fetch:async()=>Response.json({error:true,message:config.apiKey})})
 await assert.rejects(failed.action(fixture(),'primary','connect'),e=>e instanceof ApiError&&!e.message.includes(config.apiKey))
})

test('HTTP management authenticates, validates and denies operators before invoking the manager',async()=>{
 const {createApp}=await import('../src/app.ts')
 const store=fixture();let mutations=0
 const server=createApp({origin:'http://local.test',authorize:async token=>{if(token!=='valid')throw new ApiError(401,'No session');return store},whatsapp:{workspaceId:workspace,list:async()=>({instances:[],canManage:store.membership.role==='admin'}),create:async()=>{mutations++;return {} as never},action:async()=>{mutations++;return {qr:null,expiresAt:null}}}})
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string')
 const url=`http://127.0.0.1:${address.port}/api/integrations/evolution/instances`,headers={Authorization:'Bearer valid','Content-Type':'application/json','Idempotency-Key':id}
 try{
  assert.equal((await fetch(url)).status,401)
  store.membership.role='operator';assert.equal((await fetch(url+'/primary/disconnect',{method:'POST',headers})).status,403);assert.equal(mutations,0)
  store.membership.role='admin';assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({label:'x',instanceName:'other-project'})})).status,422);assert.equal(mutations,0)
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({label:'Comercial'})})).status,201);assert.equal(mutations,1)
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
