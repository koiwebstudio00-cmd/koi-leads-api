import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { seedInbox, inboxFixture as f } from './inbox-fixture.ts'
import { normalizeReaction, sendInboxReaction } from '../src/inbox/reactions.ts'
import { evaluateReplyWindow } from './helpers/inbox-reply-window.ts'
import { createInboxTextSender } from '../src/inbox/send-provider.ts'

const db=new PGlite()
const w=randomUUID(), user=randomUUID()
let message:string
before(async()=>{
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`)
  const dir=new URL('../supabase/migrations/',import.meta.url)
  for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,dir),'utf8'))
  await db.query('insert into auth.users values($1)',[user])
  await db.query("insert into koi_workspaces(id,name) values($1,'Fixtures')",[w])
  await db.query("insert into koi_workspace_members values($1,$2,'admin')",[w,user])
  await seedInbox(db,w,user)
  await db.query("insert into koi_private.inbox_bindings values(session_user,$1,'profile',$2,'ingest')",[w,user])
  message=(await db.query<{id:string}>("select id from koi_private.inbox_messages where conversation_id=$1 and external_id='live'",[f.waChat])).rows[0]!.id
})
after(()=>db.close())

type Job={id:string;status:string;lease:string;messageId:string}
const rpc=(action:string,data:unknown)=>db.transaction(async tx=>{
  await tx.exec('set local role koi_inbox_ingest')
  return (await tx.query<{result:Job|null}>('select koi_private.inbox_reaction_dispatch($1,$2) result',[action,JSON.stringify(data)])).rows[0]!.result
})
const react=(emoji:string|null,key:string,actor=user,chat=f.waChat)=>db.transaction(async tx=>{
  await tx.exec('set local role authenticated')
  await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor])
  return (await tx.query<{result:Job}>('select public.koi_inbox_react($1) result',[JSON.stringify({id:chat,messageId:message,emoji,requestId:key})])).rows[0]!.result
})
test('text-only human agent opt-in ends at exactly 168 hours and applies only to Instagram',async()=>{
  const now=new Date('2026-11-20T08:00:00Z')
  await db.exec('update koi_inbox_accounts set inbox_human_agent_enabled=true')
  for(const [channel,id] of [['instagram',f.igChat],['whatsapp',f.waChat]] as const){
    for(const hours of [23.9,24,167.9,168]){
      const input=new Date(now.getTime()-hours*3600000).toISOString()
      await db.query('update koi_inbox_conversations set last_inbound_at=$2 where id=$1',[id,input])
      for(const manualText of [false,true]){
        const expected=evaluateReplyWindow(input,now,'connected',{channel,humanAgentEnabled:true,manualText})
        const q=await db.query<{r:typeof expected}>('select koi_private.inbox_effective_window(c,a,$2,$3) r from koi_inbox_conversations c join koi_inbox_accounts a on a.id=c.account_id where c.id=$1',[id,now,manualText])
        assert.equal(q.rows[0]!.r.mode,expected.mode)
        if(channel==='instagram'&&manualText&&hours>=24&&hours<168)assert.equal(expected.mode,'human_agent')
      }
    }
  }
  await db.exec("update koi_inbox_conversations set last_inbound_at=now()-interval '2 minutes'")
})
test('reaction jobs preserve target order, idempotency, authorization and recheck eligibility',async()=>{
  const key=randomUUID(),one=await react('👍',key)
  assert.deepEqual(await react('👍',key),one)
  await assert.rejects(react('🔥',key),{code:'PT409'})
  await assert.rejects(react('👍',randomUUID(),randomUUID()),{code:'42501'})
  await assert.rejects(react('👍',randomUUID(),user,f.igChat),{code:'PT404'})
  const two=await react(null,randomUUID())
  const first=await rpc('claim',{});assert.equal(first!.id,one.id)
  assert.equal(await rpc('claim',{}),null)
  const payload=await rpc('begin',first);assert.equal(payload!.messageId,'live')
  await rpc('finish',{...first,outcome:'accepted'})
  const r=await db.query<{v:{reactions:{emoji:string}[];reactionStatus:string}}>('select koi_private.inbox_message_view(m) v from koi_private.inbox_messages m where m.id=$1',[message])
  assert.equal(r.rows[0]!.v.reactions[0]!.emoji,'👍')
  assert.equal(r.rows[0]!.v.reactionStatus,'queued')
  const second=await rpc('claim',{});assert.equal(second!.id,two.id)
  await db.query("update koi_inbox_conversations set last_inbound_at=now()-interval '25 hours' where id=$1",[f.waChat])
  assert.equal(await rpc('begin',second),null)
  assert.equal((await react('👍',key)).status,'accepted')
  await assert.rejects(react('🔥',randomUUID()),{code:'PT422'})
})
test('a WhatsApp quote resolves only a persisted target in the same conversation',async()=>{
  const quote=(chat:string,target:string)=>db.query<{ext:string}>('select koi_private.inbox_quote_external(c,$2) ext from koi_inbox_conversations c where c.id=$1',[chat,target])
  assert.equal((await quote(f.waChat,message)).rows[0]!.ext,'live')
  await assert.rejects(quote(f.igChat,message),{code:'22023'})
  const igMessage=(await db.query<{id:string}>("select id from koi_private.inbox_messages where conversation_id=$1 and external_id='live'",[f.igChat])).rows[0]!.id
  await assert.rejects(quote(f.waChat,igMessage),{code:'PT404'})
  const {rows}=await db.query<{r:{quote:{message_id:string;text:string}}}>(`with added as (
    insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,direction,body,sent_at,status,quoted_external_id)
    values($1,$2,$3,'out','Respuesta',now(),'queued','live') returning *
  ) select koi_private.inbox_message_view(added::koi_private.inbox_messages) r from added`,[w,f.wa,f.waChat])
  assert.equal(rows[0]!.r.quote.message_id,message)
  assert.equal(rows[0]!.r.quote.text,'Consulta desde WhatsApp')
  await db.query('update koi_inbox_conversations set last_inbound_at=now() where id=$1',[f.waChat])
  await db.transaction(async tx=>{
    await tx.exec('set local role authenticated')
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user])
    await tx.query("select public.koi_inbox_send('send',$1)",[{id:f.waChat,text:'Respuesta enlazada',requestId:randomUUID(),quoteTo:message}])
  })
  const dispatch=<T>(action:string,data:unknown)=>db.transaction(async tx=>{
    await tx.exec('set local role koi_inbox_ingest')
    return (await tx.query<{r:T}>('select koi_private.inbox_dispatch($1,$2) r',[action,JSON.stringify(data)])).rows[0]!.r
  })
  const job=await dispatch<{id:string;lease:string;accountId:string;conversationId:string}>('claim',{})
  const req=await dispatch<{text:string;requestId:string;expiresAt:string;replyTo:string}>('begin',{id:job.id,lease:job.lease})
  const send=createInboxTextSender('test',async(_url,init)=>{
    const body=JSON.parse(String(init?.body))
    assert.equal(body.replyTo,'live')
    assert.equal(body.messageTag,undefined)
    return Response.json({success:true,data:{messageId:'wa-reply'}})
  })
  const result=await send({...req,accountId:job.accountId,conversationId:job.conversationId})
  await dispatch('finish',{id:job.id,lease:job.lease,...result})
})
test('reaction preceding the message and older history do not restore a removed emoji',async()=>{
  const now=Date.now(),ext='late-message'
  const record=(emoji:string|null, at:number)=>db.query('select koi_private.inbox_record_reaction($1,$2,$3)',[w,f.ig,{
    externalConversationId:'thread-fixture-ig',externalMessageId:ext,outbound:false,emoji,at:new Date(at).toISOString()
  }])
  await record(null,now-1000);await record('👍',now-2000)
  const {rows}=await db.query<{id:string}>("insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,status) values($1,$2,$3,$4,'in','Hola',now(),'received') returning id",[w,f.ig,f.igChat,ext])
  const view=async()=> (await db.query<{r:{reactions:unknown[]}}>('select koi_private.inbox_message_view(m) r from koi_private.inbox_messages m where id=$1',[rows[0]!.id])).rows[0]!.r
  assert.deepEqual((await view()).reactions,[])
  await record('🔥',now);assert.deepEqual((await view()).reactions,[{emoji:'🔥',outbound:false}])
})
test('targeted status exposes a failed or unknown reaction only in the authorized thread',async()=>{
  async function status(chat:string,actor:string){
    return db.transaction(async tx=>{
      await tx.exec('set local role authenticated')
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor])
      return (await tx.query<{r:{reactionStatus:string;id:string}}>('select public.koi_inbox_reaction_status($1) r',[{id:chat,messageId:message}])).rows[0]!.r
    })
  }
  await db.query("update koi_inbox_conversations set last_inbound_at=now() where id=$1",[f.waChat])
  await react('👍',randomUUID())
  const denied=await rpc('claim',{})
  await rpc('defer',{...denied,terminal:true})
  assert.equal((await status(f.waChat,user)).reactionStatus,'failed')
  await assert.rejects(status(f.igChat,user),{code:'PT404'})
  await assert.rejects(status(f.waChat,randomUUID()),{code:'42501'})
  await db.query("update koi_inbox_conversations set last_inbound_at=now() where id=$1",[f.waChat])
  await react('🔥',randomUUID())
  const job=await rpc('claim',{});await rpc('begin',job);await rpc('finish',{...job,outcome:'unknown'})
  assert.equal((await status(f.waChat,user)).reactionStatus,'unknown')
})
test('reaction webhook omitting participantId resolves sender against the stored account-scoped participant',async()=>{
  async function record(sender:string,emoji:string,at:number){
    const r=normalizeReaction({event:'reaction.received',conversation:{platformConversationId:'thread-fixture-ig'},reaction:{
      platformMessageId:'live',messageId:'different-internal-id',sender:{id:sender},emoji,action:'added',reactedAt:new Date(Date.now()+at).toISOString()
    }})
    assert.equal(r.outbound,null)
    await db.query('select koi_private.inbox_record_reaction($1,$2,$3)',[w,f.ig,r])
  }
  await record('ana','👍',-2000);await record('business','❤️',-1000)
  const v=(await db.query<{r:{reactions:unknown[]}}>("select koi_private.inbox_message_view(m) r from koi_private.inbox_messages m where conversation_id=$1 and external_id='live'",[f.igChat])).rows[0]!.r
  assert.deepEqual(v.reactions,[{emoji:'👍',outbound:false},{emoji:'❤️',outbound:true}])
})
test('provider reaction format uses the target platform ID and DELETE query, never an automatic ambiguous retry',async()=>{
  const shape={event:'reaction.received',conversation:{platformConversationId:'thread',participantId:'contact'},reaction:{sender:{id:'contact'},emoji:'',action:'removed',platformMessageId:'platform-id',reactedAt:new Date().toISOString()}}
  assert.equal(normalizeReaction(shape).emoji,null)
  const input={accountId:'a',conversationId:'chat',messageId:'platform-id',emoji:null,expiresAt:new Date(Date.now()+60000).toISOString()}
  let calls=0
  const result=await sendInboxReaction('synthetic',input,async(url,init)=>{
    calls++;assert.equal(init?.method,'DELETE');assert.equal(init.body,undefined);assert.equal(new URL(String(url)).searchParams.get('accountId'),'a')
    throw new Error('after POST')
  })
  assert.equal(calls,1);assert.deepEqual(result,{outcome:'unknown'})
})
test('queued manual text gets HUMAN_AGENT at dispatch only for an eligible Instagram account',async()=>{
  await db.query("update koi_inbox_conversations set last_inbound_at=now()-interval '27 hours' where id=$1",[f.igChat])
  await db.query("update koi_inbox_accounts set inbox_human_agent_enabled=false where id=$1",[f.ig])
  const enqueue=()=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated')
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user])
    return tx.query("select public.koi_inbox_send('send',$1)",[JSON.stringify({id:f.igChat,text:'Respuesta manual',requestId:randomUUID()})])
  })
  await assert.rejects(enqueue(),{code:'PT422'})
  await db.query("update koi_inbox_accounts set inbox_human_agent_enabled=true where id=$1",[f.ig])
  await enqueue()
  const dispatch=<T>(action:string,data:unknown)=>db.transaction(async tx=>{
    await tx.exec('set local role koi_inbox_ingest')
    return (await tx.query<{r:T}>('select koi_private.inbox_dispatch($1,$2) r',[action,JSON.stringify(data)])).rows[0]!.r
  })
  const job=await dispatch<{id:string;lease:string;accountId:string;conversationId:string}>('claim',{})
  const req=await dispatch<{text:string;requestId:string;expiresAt:string;humanAgent:boolean}>('begin',{id:job.id,lease:job.lease})
  assert.equal(req.humanAgent,true)
  const sender=createInboxTextSender('test',async(_url,init)=>{
    const body=JSON.parse(String(init?.body))
    assert.equal(body.messageTag,'HUMAN_AGENT')
    assert.equal(body.messagingType,'MESSAGE_TAG')
    assert.equal(body.accountId,'fixture-ig')
    return Response.json({success:true,data:{messageId:'ig-human'}})
  })
  assert.deepEqual(await sender({...req,accountId:job.accountId,conversationId:job.conversationId}),{outcome:'accepted',externalId:'ig-human'})
})
