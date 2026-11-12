import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { normalizePhone, whatsappLinkPhone, prepareRows, suggestMapping } from '../src/contracts/imports.ts'
import { parseImport } from '../src/import-parser.ts'

const db = new PGlite()
const user = randomUUID(), workspace = randomUUID(), lead = randomUUID(), chat = randomUUID()
let migration: string
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`)
  const dir = new URL('../supabase/migrations/', import.meta.url)
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file,dir),'utf8')
    if (file.endsWith('_koi_whatsapp_identity.sql')) { migration = sql; continue }
    await db.exec(sql)
  }
  await db.query('insert into auth.users values($1)',[user])
  await db.query("insert into koi_workspaces(id,name) values($1,'Test')",[workspace])
  await db.query("insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,'admin')",[workspace,user])
  await db.query("insert into koi_leads(id,workspace_id,phone,created_by) values($1,$2,'543518190681',$3)",[lead,workspace,user])
  await db.query("insert into koi_private.senders(workspace_id,instance) values($1,'test')",[workspace])
  await db.query("insert into koi_conversations(id,workspace_id,instance,peer,phone,lead_id) values($1,$2,'test','5493518190681@s.whatsapp.net','5493518190681',$3)",[chat,workspace,lead])
  await db.query("insert into koi_private.chat_messages(workspace_id,conversation_id,instance,direction,body,status,provider_id) values($1,$2,'test','in','Hola','received','historical-id')",[workspace,chat])
  await db.exec(migration)
})
after(() => db.close())
async function allowed() {
  return (await db.query<{ok:boolean}>('select koi_private.contact_available($1,$2,$3) ok',[workspace,lead,'5493518190681'])).rows[0]!.ok
}
test('historical identity is migrated and both opt-out variants block the same contact', async () => {
  assert.equal(await allowed(),true)
  await db.exec('set role koi_campaign_owner')
  assert.equal((await db.query<{phone:string}>('select koi_private.whatsapp_target($1,$2,$3) phone',[workspace,lead,'543518190681'])).rows[0]!.phone,'5493518190681')
  await db.exec('reset role')
  for (const phone of ['543518190681','5493518190681']) {
    await db.query("insert into koi_suppressions(workspace_id,phone,reason) values($1,$2,'Test')",[workspace,phone])
    assert.equal(await allowed(),false)
    await db.query('delete from koi_suppressions where workspace_id=$1',[workspace])
  }
})
test('normal enqueue accepts historical alias and rejects suppression and changed identity',async () => {
  async function send() {
    return db.transaction(async tx => {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${user}',true)`)
      return tx.query('select public.koi_chat_command($1,$2)', ['send',{id:chat,key:randomUUID(),text:'Test'}])
    })
  }
  await send()
  await db.query("insert into koi_suppressions(workspace_id,phone,reason) values($1,'543518190681','Test')",[workspace])
  await assert.rejects(send(), /Contact unavailable/)
  await db.query('delete from koi_suppressions where workspace_id=$1',[workspace])
  const other = randomUUID()
  await db.query("insert into koi_leads(id,workspace_id,phone,created_by) values($1,$2,'5493518190681',$3)",[other,workspace,user])
  assert.equal(await allowed(),false)
  await assert.rejects(send(), /Contact unavailable/)
  await db.query('delete from koi_leads where id=$1',[other])
  await db.query("update koi_leads set phone='543518190682' where id=$1",[lead])
  assert.equal(await allowed(),false)
  await db.query("update koi_leads set phone='543518190681' where id=$1",[lead])
})
test('import parses explicit WhatsApp links and retains candidates without inventing digits',async () => {
  assert.equal(normalizePhone("'+543518190681",'AR').phone,'543518190681')
  assert.equal(normalizePhone('https://wa.me/5493518190681','AR').phone,'5493518190681')
  assert.ok(normalizePhone("'+54 1234567",'AR').error)
  assert.equal(whatsappLinkPhone('https://wa.me/message/ABCD'),null)
  assert.equal(whatsappLinkPhone('https://wa.me.evil.test/5493518190681'),null)
  const draft = await parseImport(Buffer.from('name,phone,whatsapp\nYoni,+543518190681,https://wa.me/5493518190681'),{filename:'test.csv',sheet:1,headerRow:1,delimiter:',',encoding:'utf-8'})
  const rows = prepareRows(draft,{mapping:suggestMapping(draft.headers),country:'AR',trim:true,edits:{},consents:{}})
  assert.equal(rows[0]!.extra.whatsapp_candidate,'5493518190681')
})

test('worker rechecks opt-outs after enqueue and releases the instance',async () => {
  await db.query("insert into koi_private.machine_bindings(role_name,workspace_id,kind) values(session_user,$1,'chat-worker')",[workspace])
  await db.query('update koi_private.senders set chat_enabled=true where workspace_id=$1',[workspace])
  await db.exec("update koi_private.chat_messages set status='closed' where status='queued'")
  const id=randomUUID(), token=randomUUID()
  await db.query("insert into koi_private.chat_messages(id,workspace_id,conversation_id,instance,direction,body,status,lease_token,lease_until) values($1,$2,$3,'test','out','Test','leased',$4,now()+interval '90 seconds')",[id,workspace,chat,token])
  await db.query("select koi_private.dispatch_lock($1,'test')",[workspace])
  await db.query("update koi_private.dispatch_instances set lane='chat',job_id=$1,token=$2,lease_until=now()+interval '90 seconds' where workspace_id=$3 and instance='test'",[id,token,workspace])
  await db.query("insert into koi_suppressions(workspace_id,phone,reason) values($1,'543518190681','After enqueue')",[workspace])
  const result=await db.query<{result:unknown}>("select koi_private.chat_machine('chat_begin',$1) result",[{instance:'test',id,token}])
  assert.equal(result.rows[0]!.result,null)
  assert.equal((await db.query<{status:string}>('select status from koi_private.chat_messages where id=$1',[id])).rows[0]!.status,'failed')
  assert.equal((await db.query<{job_id:string|null}>('select job_id from koi_private.dispatch_instances where workspace_id=$1',[workspace])).rows[0]!.job_id,null)
})
