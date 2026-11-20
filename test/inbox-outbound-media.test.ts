import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { inboxFixture as f, seedInbox } from './inbox-fixture.ts'
import { inboxManualSendInput } from '../src/inbox/outbound-media.ts'
import { createInboxTextSender } from '../src/inbox/send-provider.ts'
import { createInboxSendCycle } from '../src/inbox/send-cycle.ts'
import type { ZernioClient } from '../src/inbox/provider.ts'
import type { MachineCommand } from '../src/campaigns/machine-store.ts'

const db = new PGlite()
const workspace = randomUUID(), member = randomUUID(), outsider = randomUUID()
const attachment = {name:'brief.pdf',mime:'application/pdf' as const,base64:Buffer.from('%PDF-1.7\nfixture').toString('base64')}
before(async () => {
 await db.exec(`create role anon; create role authenticated; create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth,public to anon,authenticated;`)
 const directory = new URL('../supabase/migrations/', import.meta.url)
 for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) {
   await db.exec(await readFile(new URL(file,directory),'utf8'))
 }
 await db.query('insert into auth.users values($1),($2)',[member,outsider])
 await db.query("insert into koi_workspaces(id,name) values($1,'Koi')",[workspace])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[workspace,member])
 await seedInbox(db,workspace,member)
 await db.query("insert into koi_private.inbox_bindings values(session_user,$1,'p',$2,'ingest')",[workspace,member])
})
after(()=>db.close())
beforeEach(async()=>{
 await db.exec("delete from koi_private.inbox_outbox;update koi_inbox_conversations set last_inbound_at=now()-interval '1 minute'")
})

async function rpc<T>(action:string,data:Record<string,unknown>,actor=member):Promise<T> {
 return db.transaction(async tx=>{
  await tx.exec('set local role authenticated')
  await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor])
  return (await tx.query<{r:T}>('select koi_inbox_send($1,$2) r',[action,JSON.stringify(data)])).rows[0]!.r
 })
}
const dispatch: MachineCommand = async <T>(action:string,data:Record<string,unknown>)=>db.transaction(async tx=>{
 await tx.exec('set local role koi_inbox_ingest')
 return (await tx.query<{r:T}>('select koi_private.inbox_dispatch($1,$2) r',[action,JSON.stringify(data)])).rows[0]!.r
})
const provider = {account: async (id:string)=>({_id:id,profileId:'p',platform:id==='fixture-wa'?'whatsapp':'instagram',isActive:true})} as unknown as ZernioClient
function rejected(code:string) { return (e:unknown)=>(e as {code:string}).code===code }

test('queued files are durable, scoped and idempotent, then uploaded and delivered only after a checked lease', async()=>{
 const body={id:f.waChat,text:'El brief',requestId:randomUUID(),attachment}
 const {id}=await rpc<{id:string}>('send',body)
 assert.equal((await rpc<{id:string}>('send',body)).id,id)
 await assert.rejects(rpc('send',{...body,attachment:{...attachment,name:'otro.pdf'}}),rejected('PT409'))
 const args={id:f.waChat,messageId:id,index:0}
 assert.deepEqual(await rpc('local_media',args),{...attachment,voiceNote:false})
 assert.equal(await rpc('local_media',{...args,id:f.igChat}),null)
 await assert.rejects(rpc('local_media',args,outsider),rejected('42501'))
 const calls:string[]=[]
 const send=createInboxTextSender('fake-credential',async(raw,init)=>{
   const url=String(raw)
   calls.push(url)
   if(url.endsWith('/presign')) return Response.json({uploadUrl:'https://test.r2.cloudflarestorage.com/file?signature=fixture',publicUrl:'https://media.zernio.com/temp/fixture'})
   if(init?.method==='PUT') {
     assert.equal(new Headers(init.headers).get('Authorization'),null)
     assert.equal(Buffer.from(init.body as Buffer).toString('base64'),attachment.base64)
     return new Response(null,{status:200})
   }
   const payload=JSON.parse(String(init?.body))
   assert.deepEqual(payload,{accountId:'fixture-wa',message:'El brief',attachmentUrl:'https://media.zernio.com/temp/fixture',attachmentName:'brief.pdf',attachmentType:'file'})
   return Response.json({success:true,data:{messageId:'wa-fixture'}})
 })
 assert.equal(await createInboxSendCycle(dispatch,provider,send,{workspaceId:workspace,profileId:'p',richEnabled:true})(),true)
 assert.equal(calls.length,3)
 assert.equal((await db.query<{status:string}>('select status from koi_private.inbox_messages where id=$1',[id])).rows[0]!.status,'accepted')
})

test('direct RPC enforces containers, channel restrictions, independent Instagram sends and a real native sticker',async()=>{
 for (const [id,file,text] of [
   [f.waChat,{...attachment,base64:Buffer.from('not a pdf').toString('base64')},''],
   [f.waChat,{...attachment,voiceNote:true},''],
   [f.igChat,attachment,'caption'],
 ] as const) await assert.rejects(rpc('send',{id,requestId:randomUUID(),text,attachment:file}),rejected('22023'))
 assert.equal(inboxManualSendInput.safeParse({attachment:{...attachment,base64:'YWJjZA=='}}).success,false)
 await assert.rejects(rpc('send',{id:f.waChat,requestId:randomUUID(),sticker:'like_heart'}),rejected('22023'))
 const {nativeSticker}=await rpc<{nativeSticker:string}>('send',{id:f.igChat,requestId:randomUUID(),sticker:'like_heart'})
 assert.equal(nativeSticker,'like_heart')
 let body:unknown
 const send=createInboxTextSender('fixture',async(_,init)=>{body=JSON.parse(String(init?.body));return Response.json({success:true,data:{messageId:'ig-heart'}})})
 await createInboxSendCycle(dispatch,provider,send,{workspaceId:workspace,profileId:'p',richEnabled:true})()
 assert.deepEqual(body,{accountId:'fixture-ig',sticker:'like_heart'})
})

test('the window is checked again after upload and before a media POST',async()=>{
 await rpc('send',{id:f.waChat,requestId:randomUUID(),attachment})
 let sends=0
 const sender=Object.assign(async()=>{sends++;return {outcome:'accepted' as const,externalId:'unexpected'}},{
   upload:async()=>{await db.query("update koi_inbox_conversations set last_inbound_at=now()-interval '25 hours' where id=$1",[f.waChat]);return 'https://media.zernio.com/temp/test'}
 })
 await createInboxSendCycle(dispatch,provider,sender,{workspaceId:workspace,profileId:'p',richEnabled:true})()
 assert.equal(sends,0)
 const states=await db.query<{reason:string}>("select reason from koi_private.inbox_outbox where status='failed' and conversation_id=$1",[f.waChat])
 assert.equal(states.rows.at(-1)?.reason,'expired')
})

test('a disabled rollout cannot deliver rich content queued via the RPC',async()=>{
 await rpc('send',{id:f.igChat,requestId:randomUUID(),sticker:'like_heart'})
 let sends=0
 await createInboxSendCycle(dispatch,provider,async()=>{sends++;return {outcome:'accepted',externalId:'unexpected'}},{
   workspaceId:workspace,profileId:'p',richEnabled:false
 })()
 assert.equal(sends,0)
 const rows=await db.query("select id from koi_private.inbox_outbox where status='failed' and reason='rich_send_disabled'")
 assert.equal(rows.rows.length,1)
})

test('a WhatsApp operator can send UTF-8 document bytes, while Instagram accepts PDFs only',async()=>{
 const doc={name:'pedido.txt',mime:'text/plain',base64:Buffer.from('Sí, confirmado.').toString('base64')}
 assert.equal(inboxManualSendInput.safeParse({attachment:doc}).success,true)
 const message=await rpc<{id:string}>('send',{id:f.waChat,requestId:randomUUID(),attachment:doc})
 assert.ok(message.id)
 await assert.rejects(rpc('send',{id:f.igChat,requestId:randomUUID(),attachment:doc}),rejected('22023'))
 await assert.rejects(rpc('send',{id:f.waChat,requestId:randomUUID(),attachment:{...doc,base64:'AA=='}}),rejected('22023'))
})

test('a recorded WebM stays playable locally and dispatches as a native WhatsApp voice note',{
 skip:spawnSync('ffmpeg',['-version'],{timeout:3000,windowsHide:true}).status!==0?'requires Inbox worker ffmpeg':false
},async()=>{
 const sample=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:duration=0.25','-ac','2','-c:a','libopus','-f','webm','pipe:1'],{timeout:6000,windowsHide:true})
 assert.equal(sample.status,0)
 const recording={name:'mic.webm',mime:'audio/webm',base64:sample.stdout.toString('base64'),voiceNote:true}
 const message=await rpc<{id:string}>('send',{id:f.waChat,requestId:randomUUID(),attachment:recording})
 let delivered:unknown
 const send=createInboxTextSender('test',async(url,init)=>{
   if(String(url).endsWith('/presign')) {
     assert.equal(JSON.parse(String(init?.body)).contentType,'audio/ogg')
     return Response.json({uploadUrl:'https://test.r2.cloudflarestorage.com/voice',publicUrl:'https://media.zernio.com/temp/voice.ogg'})
   }
   if(init?.method==='PUT'){
     assert.ok(Buffer.from(init.body as Buffer).subarray(0,4).equals(Buffer.from('OggS')))
     return new Response(null,{status:200})
   }
   delivered=JSON.parse(String(init?.body))
   return Response.json({success:true,data:{messageId:'wa-voice'}})
 })
 await createInboxSendCycle(dispatch,provider,send,{workspaceId:workspace,profileId:'p',richEnabled:true})()
 assert.deepEqual(delivered,{accountId:'fixture-wa',attachmentType:'audio',attachmentName:'nota-de-voz.ogg',attachmentUrl:'https://media.zernio.com/temp/voice.ogg',voiceNote:true})
 assert.deepEqual(await rpc('local_media',{id:f.waChat,messageId:message.id,index:0}),recording)
})
