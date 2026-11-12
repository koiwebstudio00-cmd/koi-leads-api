import { listenForChat } from '../src/chat-worker-listener.ts'
import { createChatMedia } from '../src/conversations.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatWorkerCycle } from '../src/chat-worker-cycle.ts'
import { createWakeup } from '../src/worker-wakeup.ts'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'

test('chat dispatcher persists begin before HTTP and does not repeat POST after persistence failure',async()=>{
 const calls:string[]=[];let sends=0
 const command:MachineCommand=async <T>(action:string)=>{
  calls.push(action)
  if(action==='chat_claim')return {id:'job',token:'lease',instance:'account'} as T
  if(action==='chat_begin')return {phone:'5493811111111',text:'Test',mime:null,fileName:null,base64:null} as T
  throw new Error('persistence failed')
 }
 await assert.rejects(chatWorkerCycle({command,instance:'primary',account:'account',signal:new AbortController().signal,
  connected:async()=>true,send:async()=>{sends++;assert.equal(calls.at(-1),'chat_begin');return {outcome:'accepted',providerId:'provider'}}}),/persistence failed/)
 assert.equal(sends,1);assert.deepEqual(calls,['chat_claim','chat_begin','chat_finish'])
})
test('cancelled lease never calls provider and a disconnected account defers',async()=>{
 let sent=0;const calls:string[]=[]
 const command:MachineCommand=async <T>(action:string)=>{calls.push(action);return (action==='chat_claim'?{id:'job',token:'lease',instance:'account'}:null) as T}
 const options={command,instance:'primary',account:'account',signal:new AbortController().signal,connected:async()=>true,send:async()=>{sent++;return {outcome:'accepted' as const,providerId:'x'}}}
 assert.equal(await chatWorkerCycle(options),true);assert.equal(sent,0)
 assert.equal(await chatWorkerCycle({...options,connected:async()=>false}),false)
 assert.equal(calls.at(-1),'chat_defer');assert.equal(sent,0)
})
test('wakeups coalesce, retain early notifications and stop immediately on abort',async()=>{
 const wake=createWakeup(),controller=new AbortController()
 wake.wake();wake.wake();await wake.wait(30000,controller.signal)
 const pending=wake.wait(30000,controller.signal);wake.wake();await pending
 const stopped=wake.wait(30000,controller.signal);controller.abort();await stopped
})

test('media preserves the provider Retry-After without automatically repeating a POST',async()=>{
 let calls=0
 const media=createChatMedia({url:'https://provider.example.test',apiKey:'synthetic'},async()=>{
  calls++;return new Response('{}',{status:429,headers:{'retry-after':'120'}})
 })
 const result=await media.send('synthetic',{phone:'5493811111111',text:'Test',mime:'application/pdf',fileName:'test.pdf',base64:Buffer.from('%PDF-1.7 fixture').toString('base64')})
 assert.deepEqual(result,{outcome:'unknown',reason:'provider_429',retryAfterSeconds:120});assert.equal(calls,1)
})

test('invalid optional listener configuration falls back without exposing credentials or rejecting',async context=>{
 const errors:string[]=[]
 context.mock.method(console,'error',(line:string)=>{errors.push(line)})
 await listenForChat('not-a-database-secret',undefined,()=>assert.fail('should not connect'),new AbortController().signal)
 assert.deepEqual(errors,[JSON.stringify({event:'chat_listener_invalid_configuration'})])
})
