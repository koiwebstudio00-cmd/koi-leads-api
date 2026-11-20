import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { evaluateReplyWindow } from '../src/inbox/reply-window.ts'
import { inboxAccount, inboxSendInput, inboxAction, inboxIndexQuery } from '../src/inbox/contracts.ts'
import { leadInput } from '../src/lead-input.ts'

const db = new PGlite()
const w = randomUUID(), other = randomUUID(), owner = randomUUID(), operator = randomUUID(), outsider = randomUUID()
const account = randomUUID(), secondAccount = randomUUID(), foreignAccount = randomUUID()
const lead = randomUUID(), foreignLead = randomUUID(), phoneLead = randomUUID()
const identity = randomUUID(), conversation = randomUUID(), secondConversation = randomUUID(), list = randomUUID()

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;`)
  const dir = new URL('../supabase/migrations/', import.meta.url)
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'))
  }
  await db.query('insert into auth.users(id) values($1),($2),($3)', [owner, operator, outsider])
  await db.query("insert into koi_workspaces(id,name) values($1,'Koi'),($2,'Other')", [w, other])
  await db.query("insert into koi_workspace_members values($1,$2,'admin'),($1,$3,'operator'),($4,$5,'admin')", [w, owner, operator, other, outsider])
  await db.query("insert into koi_leads(id,workspace_id,phone,name,created_by) values($1,$2,null,'Instagram',$3),($4,$5,null,'Other',$6),($7,$2,'5493811111111','Phone',$3)", [lead,w,owner,foreignLead,other,outsider,phoneLead])
  await db.query("insert into koi_inbox_accounts(id,workspace_id,channel,external_id,label,state,created_by) values($1,$2,'instagram','ig-koi','Koi','connected',$3),($4,$2,'whatsapp','wa-koi','WA','connected',$3),($5,$6,'instagram','ig-other','Other','connected',$7)", [account,w,owner,secondAccount,foreignAccount,other,outsider])
  await db.query("insert into koi_private.inbox_identities(id,workspace_id,account_id,channel,lead_id,external_id) values($1,$2,$3,'instagram',$4,'person')", [identity,w,account,lead])
  await db.query("insert into koi_inbox_conversations(id,workspace_id,account_id,channel,external_id,identity_id,lead_id,assigned_to) values($1,$2,$3,'instagram','thread-1',$4,$5,$6),($7,$2,$3,'instagram','thread-2',$4,$5,null)", [conversation,w,account,identity,lead,operator,secondConversation])
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner])
  await db.query("insert into koi_lead_lists(id,workspace_id,name,request_id,created_by) values($1,$2,'Mixed',$3,$4)", [list,w,randomUUID(),owner])
  await db.exec('reset request.jwt.claim.sub')
  await db.query('insert into koi_lead_list_members(workspace_id,list_id,lead_id) values($1,$2,$3),($1,$2,$4)', [w,list,lead,phoneLead])
  await db.query("insert into koi_private.senders(workspace_id,instance) values($1,'test')", [w])
})
after(() => db.close())

async function asUser(actor: string, sql: string, params: unknown[] = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${actor}',true)`)
    return tx.query<Record<string, unknown>>(sql, params)
  })
}
const rejectsCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => (error as {code?:string}).code === code)

test('Inbox contracts reject provider mixing, window bypasses and caller-controlled ownership', () => {
  assert.equal(inboxAccount.safeParse({id:account,workspaceId:w,provider:'evolution',channel:'whatsapp',externalId:'a',label:'a',address:null,state:'connected'}).success, false)
  assert.equal(inboxSendInput.safeParse({text:' Hola '}).success, true)
  for (const payload of [{text:''}, {text:'a',accountId:secondAccount}, {text:'a',template:'x'}, {text:'a',messageTag:'HUMAN_AGENT'}, {text:'a',sentAt:'2026-11-20'}, {text:'a',attachmentIds:[lead,lead]}]) {
    assert.equal(inboxSendInput.safeParse(payload).success, false)
  }
  assert.equal(inboxIndexQuery.safeParse({after:lead,ids:[lead]}).success, false)
  assert.equal(inboxAction.safeParse({action:'read',throughMessageId:lead,workspaceId:w}).success, false)
})

test('SQL and server policy agree at 24h, for future/missing dates and disconnected accounts', async () => {
  const now = new Date('2026-11-20T12:00:00.000Z')
  for (const inbound of [null, '2026-11-19T12:00:00.001Z', '2026-11-19T12:00:00.000Z', '2026-11-19T11:59:59.999Z', '2026-11-20T12:00:00.001Z']) {
    for (const state of ['connected','disconnected','pending','error'] as const) {
      const expected = evaluateReplyWindow(inbound, now, state)
      const {rows} = await db.query<{result: typeof expected}>('select koi_private.inbox_reply_window($1,$2,$3) result', [inbound,now.toISOString(),state])
      const actual = rows[0]!.result
      assert.equal(actual.canReply, expected.canReply)
      assert.equal(actual.reason, expected.reason)
      assert.equal(actual.expiresAt && new Date(actual.expiresAt).toISOString(), expected.expiresAt)
    }
  }
  assert.equal(evaluateReplyWindow('invalid',now,'connected').reason,'invalid_inbound')
  assert.throws(() => evaluateReplyWindow(null,new Date('invalid'),'connected'))
})

test('members can read only their summaries; provider state and private data are not writable', async () => {
  for (const actor of [owner,operator]) {
    assert.equal((await asUser(actor,'select id from koi_inbox_accounts')).rows.length,2)
    assert.equal((await asUser(actor,'select id from koi_inbox_conversations')).rows.length,2)
    await rejectsCode(asUser(actor,"update koi_inbox_conversations set last_inbound_at=now()"),'42501')
    await rejectsCode(asUser(actor,"update koi_inbox_accounts set state='connected'"),'42501')
    for (const table of ['inbox_messages','inbox_events','inbox_outbox','inbox_reads','inbox_identities','inbox_files','inbox_attribution']) {
      await rejectsCode(asUser(actor,`select * from koi_private.${table}`),'42501')
    }
  }
  assert.equal((await asUser(outsider,'select id from koi_inbox_conversations')).rows.length,0)
  assert.equal((await asUser(randomUUID(),'select id from koi_inbox_accounts')).rows.length,0)
  await rejectsCode(db.transaction(async tx => {await tx.exec('set local role anon'); return tx.query('select * from koi_inbox_accounts')}),'42501')
  const grants = await db.query<{allowed:boolean}>("select has_function_privilege('anon','koi_private.inbox_reply_window(timestamptz,timestamptz,text)','execute') allowed")
  assert.equal(grants.rows[0]!.allowed,false)
})

test('compound references reject foreign workspaces, channels, contacts and assignees', async () => {
  await rejectsCode(db.query("insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id) values($1,$2,'instagram',$3,'bad')", [w,foreignAccount,lead]),'23503')
  await rejectsCode(db.query("insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id) values($1,$2,'whatsapp',$3,'bad')", [w,account,lead]),'23503')
  await rejectsCode(db.query("insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id) values($1,$2,'instagram',$3,'bad')", [w,account,foreignLead]),'23503')
  await rejectsCode(db.query('update koi_inbox_conversations set assigned_to=$1 where id=$2', [outsider,conversation]),'23503')
  await rejectsCode(db.query('update koi_inbox_conversations set lead_id=$1 where id=$2', [phoneLead,conversation]),'23503')
  await rejectsCode(db.query("insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,direction,sent_at,status) values($1,$2,$3,'in',now(),'received')", [w,secondAccount,conversation]),'23503')
  await db.query("insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id) values($1,$2,'whatsapp',$3,'person')", [w,secondAccount,lead])
  await rejectsCode(db.query("insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id) values($1,$2,'instagram',$3,'person')", [w,account,phoneLead]),'23505')
})

test('event/message uniqueness and scoped read/attachment references prevent duplicates and cross-chat links', async () => {
  const message = randomUUID()
  await db.query("insert into koi_private.inbox_messages(id,workspace_id,account_id,conversation_id,external_id,direction,sent_at,status) values($1,$2,$3,$4,'message-1','in',now(),'received')", [message,w,account,conversation])
  await rejectsCode(db.query("insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,sent_at,status) values($1,$2,$3,'message-1','in',now(),'received')", [w,account,conversation]),'23505')
  await db.query("insert into koi_private.inbox_events(workspace_id,account_id,external_id,kind,payload) values($1,$2,'event-1','message.received','{}')", [w,account])
  await rejectsCode(db.query("insert into koi_private.inbox_events(workspace_id,account_id,external_id,kind,payload) values($1,$2,'event-1','message.received','{}')", [w,account]),'23505')
  await rejectsCode(db.query('insert into koi_private.inbox_reads values($1,$2,$3,$4,now())',[w,secondConversation,owner,message]),'23503')
  await rejectsCode(db.query("insert into koi_private.inbox_files(workspace_id,conversation_id,message_id,object_key,kind,name,mime,bytes) values($1,$2,$3,'bad-link','image','a','image/png',1)", [w,secondConversation,message]),'23503')
})

test('social contacts work in CRM; EvoAPI and campaign snapshots remain phone-only', async () => {
  const input = {revision:0,name:'IG',company:'',source:'instagram',email:'',phone:null}
  assert.equal(leadInput.parse(input).phone,null)
  assert.equal(leadInput.safeParse({...input,phone:''}).success,false)
  await asUser(operator,"update koi_leads set name='Instagram edited' where id=$1",[lead])
  const crm = await asUser(operator,"select koi_crm_command('detail',$1) result",[{id:lead}])
  assert.equal((crm.rows[0]!.result as {lead:{phone:null}}).lead.phone,null)
  await rejectsCode(db.query('update koi_leads set phone=null where id=$1',[phoneLead]),'23514')
  await rejectsCode(db.query("update koi_leads set phone='bad' where id=$1",[lead]),'23514')
  await rejectsCode(asUser(owner,"select koi_crm_command('create',$1)",[{name:'No phone',phone:null,key:randomUUID()}]),'22023')
  await rejectsCode(asUser(owner,"select koi_chat_command('send_new',$1)",[{leadId:lead,instanceId:'primary',key:randomUUID(),text:'Hola'}]),'22023')
  const picker = await asUser(owner,"select koi_campaign_recipient_picker($1,'','','all',1,null) result",[list])
  assert.equal((picker.rows[0]!.result as {total:number}).total,1)
  const campaign = randomUUID()
  await db.query("insert into koi_campaigns(id,workspace_id,list_id,name,template,config,create_key,create_body,created_by) values($1,$2,$3,'Mixed','Hola','{}',$4,'{}',$5)",[campaign,w,list,randomUUID(),owner])
  const candidates = await db.query<{lead_id:string;phone:string}>('select * from koi_private.campaign_candidates($1)',[campaign])
  assert.deepEqual(candidates.rows.map(row=>row.lead_id),[phoneLead])
  // Inbox IDs cannot be read through the existing EvoAPI RPC.
  await rejectsCode(asUser(owner,"select koi_chat_command('detail',$1)",[{id:conversation}]),'PT404')
})


test('outbox keeps request idempotency, account scope and one unresolved dispatch per conversation', async () => {
  const ids=[randomUUID(),randomUUID(),randomUUID()], key=randomUUID()
  for (const id of ids) await db.query("insert into koi_private.inbox_messages(id,workspace_id,account_id,conversation_id,direction,sent_at,status,actor_id) values($1,$2,$3,$4,'out',now(),'queued',$5)",[id,w,account,conversation,owner])
  const enqueue = (id:string, requestId:string, accountId=account) => db.query("insert into koi_private.inbox_outbox(workspace_id,account_id,conversation_id,message_id,actor_id,request_id,request_hash) values($1,$2,$3,$4,$5,$6,$7)",[w,accountId,conversation,id,owner,requestId,'a'.repeat(64)])
  await enqueue(ids[0]!,key)
  await rejectsCode(enqueue(ids[1]!,key),'23505')
  await rejectsCode(enqueue(ids[2]!,randomUUID(),secondAccount),'23503')
  await enqueue(ids[1]!,randomUUID())
  await db.query("update koi_private.inbox_outbox set status='unknown' where message_id=$1",[ids[0]])
  await rejectsCode(db.query("update koi_private.inbox_outbox set status='leased',lease_token=$1,lease_until=now()+interval '1 minute' where message_id=$2",[randomUUID(),ids[1]]),'23505')
  await db.query("update koi_private.inbox_outbox set status='accepted' where message_id=$1",[ids[0]])
  await db.query("update koi_private.inbox_outbox set status='leased',lease_token=$1,lease_until=now()+interval '1 minute' where message_id=$2",[randomUUID(),ids[1]])
})
