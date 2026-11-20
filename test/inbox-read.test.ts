import { before,after,test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir,readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { seedInbox,inboxFixture as f } from './inbox-fixture.ts'
import { createInboxReadMedia,validateInboxMediaUrl } from '../src/inbox/media.ts'
import { inboxReadRoute,type MediaLookup } from '../src/inbox/read.ts'
import type { ZernioClient } from '../src/inbox/provider.ts'
import type { IncomingMessage } from 'node:http'
const db=new PGlite(),w=randomUUID(),user=randomUUID(),operator=randomUUID(),other=randomUUID()
before(async()=>{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
 create publication supabase_realtime;`)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 for(const file of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'))
 await db.query('insert into auth.users values($1),($2),($3)',[user,operator,other])
 await db.query("insert into koi_workspaces(id,name) values($1,'Koi')",[w])
 await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'operator')",[w,user,operator])
 await seedInbox(db,w,user)
})
after(()=>db.close())
type Row={id:string;unread:number;readRevision:number;assignedTo:string|null;lastMessageAt:string;replyWindow:{canReply:boolean}}
type Message={id:string;seq:number;body:string;attachments:{index:number}[]}
type History={conversation:Row;messages:Message[];nextCursor:string|null}
async function query<T>(action:string,data:Record<string,unknown>={},actor=user):Promise<T>{return db.transaction(async tx=>{
 await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor])
 return (await tx.query<{result:T}>('select koi_inbox_query($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result
})}
const denied=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>(e as {code:string}).code===code)
test('read model isolates membership, conversations, media and private payloads',async()=>{
 const index=await query<{rows:Row[]}>('index');assert.equal(index.rows.length,2)
 assert.equal(index.rows[0]!.unread,1)
 const h=await query<History>('messages',{id:f.waChat});assert.equal(h.messages.length,50);assert.equal(h.conversation.replyWindow.canReply,true)
 assert.equal(h.messages.at(-1)!.attachments.length,2)
 assert.ok(!JSON.stringify(h).includes('provider_attachments'))
 await denied(query('index',{},other),'42501');await denied(query('messages',{id:randomUUID()}),'PT404')
 const ig=await query<History>('messages',{id:f.igChat})
 await denied(query('media_lookup',{id:f.waChat,messageId:ig.messages.at(-1)!.id,index:0}),'PT404')
 const lookup=await query<MediaLookup>('media_lookup',{id:f.waChat,messageId:h.messages.at(-1)!.id,index:1})
 assert.equal(lookup.accountId,'fixture-wa');assert.equal(lookup.name,'propuesta.pdf')
 for(const table of ['inbox_messages','inbox_reads'])await denied(db.transaction(async tx=>{await tx.exec('set local role authenticated');return tx.query('select * from koi_private.'+table)}),'42501')
 const published=(await db.query<{tablename:string}>("select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename like '%inbox%' order by tablename")).rows.map(r=>r.tablename)
 assert.deepEqual(published,['koi_inbox_accounts','koi_inbox_conversations'])
})
test('keyset history visits identical timestamps once and rejects a different chat cursor',async()=>{
 const seen=new Set<string>();let cursor:string|null=null
 do{
  const h:History=await query<History>('messages',{id:f.waChat,limit:7,...(cursor?{before:cursor}:{})})
  for(const m of h.messages){assert.ok(!seen.has(m.id));seen.add(m.id)}cursor=h.nextCursor
 }while(cursor)
 assert.equal(seen.size,61)
 const ig=await query<History>('messages',{id:f.igChat})
 await denied(query('messages',{id:f.waChat,before:ig.messages[0]!.id}),'PT404')
})
test('read revisions protect manual unread, isolate users and preserve messages after the anchor',async()=>{
 const h=await query<History>('messages',{id:f.waChat}),anchor=h.messages.at(-1)!.id
 const read=await query<Row>('read',{id:f.waChat,throughMessageId:anchor,revision:0});assert.equal(read.unread,0)
 assert.equal((await query<History>('messages',{id:f.waChat},operator)).conversation.unread,1)
 const unread=await query<Row>('unread',{id:f.waChat});assert.equal(unread.unread,1)
 const stale=await query<Row>('read',{id:f.waChat,throughMessageId:anchor,revision:read.readRevision});assert.equal(stale.unread,1)
 const newId=randomUUID()
 await db.query("insert into koi_private.inbox_messages(id,workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,status) values($1,$2,$3,$4,'after-read','in','Llegó después',now(),'received')",[newId,w,f.wa,f.waChat])
 const old=await query<Row>('read',{id:f.waChat,throughMessageId:anchor,revision:unread.readRevision});assert.equal(old.unread,1)
 const complete=await query<Row>('read',{id:f.waChat,throughMessageId:newId,revision:old.readRevision});assert.equal(complete.unread,0)
 assert.equal((await query<{count:number}>('unread_count')).count,1)
})
test('assignment shares the CRM lead while archive is per conversation and retains chronological order',async()=>{
 await denied(query('assign',{id:f.waChat,assignedTo:other}),'42501')
 await query('assign',{id:f.waChat,assignedTo:operator})
 assert.equal((await query<History>('messages',{id:f.igChat})).conversation.assignedTo,operator)
 const before=await query<History>('messages',{id:f.igChat})
 await query('archive',{id:f.igChat,archived:true})
 assert.equal((await query<{count:number}>('unread_count')).count,0)
 assert.equal((await query<History>('messages',{id:f.igChat})).conversation.lastMessageAt,before.conversation.lastMessageAt)
 await query('archive',{id:f.igChat,archived:false})
 await db.query('update koi_leads set deleted_at=now() where id=$1',[f.lead])
 assert.equal((await query<{rows:unknown[]}>('index')).rows.length,0)
 await denied(query('messages',{id:f.igChat}),'PT404')
 await db.query('update koi_leads set deleted_at=null where id=$1',[f.lead])
})
test('summary scan loads more than 200 rows with stable UUID cursors and scoped refreshes',async()=>{
 await db.query("insert into koi_inbox_conversations(workspace_id,account_id,channel,external_id,identity_id,lead_id) select workspace_id,account_id,channel,'page-'||n,identity_id,lead_id from koi_inbox_conversations cross join generate_series(1,205) n where id=$1",[f.waChat])
 const first=await query<{rows:Row[];nextCursor:string}>('index');assert.equal(first.rows.length,200);assert.ok(first.nextCursor)
 const second=await query<{rows:Row[];nextCursor:null}>('index',{after:first.nextCursor});assert.equal(second.rows.length,7);assert.equal(second.nextCursor,null)
 assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,207)
 const specific=await query<{rows:Row[]}>('index',{ids:[f.waChat,f.igChat,randomUUID()]});assert.equal(specific.rows.length,2)
 await denied(query('index',{ids:[f.waChat],after:first.nextCursor}),'22023')
 await db.query("delete from koi_inbox_conversations where external_id like 'page-%'")
})
const lookup:MediaLookup={accountId:'authorized',conversationId:'thread',messageId:'message',index:0,name:'photo.png'}
const provider=(url:string)=>({attachment:async()=>({url})}) as unknown as ZernioClient
test('media follows vetted hosts and never forwards the provider token to a CDN',async()=>{
 for(const url of ['http://zernio.com/api/v1/whatsapp/media/123','https://localhost/a','https://fbcdn.net.evil.test/a','https://zernio.com/other','https://a:pass@fbcdn.net/a'])assert.throws(()=>validateInboxMediaUrl(url,lookup.accountId))
 const calls:{url:string;authorization:string|null}[]=[]
 const read=createInboxReadMedia(provider('https://zernio.com/api/v1/whatsapp/media/123?accountId=foreign'),'synthetic-secret',async(input,init)=>{
  calls.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')})
  return calls.length===1?new Response(null,{status:302,headers:{location:'https://image.fbcdn.net/test'}}):new Response('image',{headers:{'content-type':'image/png'}})
 })
 assert.equal((await read(lookup)).base64,Buffer.from('image').toString('base64'))
 assert.ok(calls[0]!.url.includes('accountId=authorized'));assert.equal(calls[0]!.authorization,'Bearer synthetic-secret');assert.equal(calls[1]!.authorization,null)
 let hits=0
 await assert.rejects(createInboxReadMedia(provider('https://image.fbcdn.net/test'),'secret',async()=>{hits++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})})(lookup))
 assert.equal(hits,1)
 await assert.rejects(createInboxReadMedia(provider('https://image.fbcdn.net/test'),'secret',async()=>new Response('x',{headers:{'content-length':String(21*1024*1024)}}))(lookup),/20 MiB/)
})
test('HTTP media checks visibility first and does not expose a send route',async()=>{
 let providerCalls=0
 const request={method:'GET'} as IncomingMessage
 const url=new URL(`http://local/api/inbox/conversations/${f.waChat}/attachments?messageId=${randomUUID()}&index=0`)
 await assert.rejects(inboxReadRoute(request,url,async()=>{throw new Error('denied')},async()=>({}),async()=>{providerCalls++;return {base64:'',mime:'',name:''}}),/denied/)
 assert.equal(providerCalls,0)
 await assert.rejects(inboxReadRoute({method:'POST'} as IncomingMessage,new URL(`http://local/api/inbox/conversations/${f.waChat}/messages`),async()=>null,async()=>({})),/Método no permitido/)
})
