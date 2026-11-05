import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const admin = '11111111-1111-4111-8111-111111111111'
const operator = '22222222-2222-4222-8222-222222222222'
const other = '33333333-3333-4333-8333-333333333333'
const outsider = '44444444-4444-4444-8444-444444444444'
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
let listId: string

before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    insert into auth.users values ('${admin}'),('${operator}'),('${other}'),('${outsider}');`)
  await db.exec(await readFile(new URL('../supabase/migrations/20261105025724_koi_foundation.sql', import.meta.url), 'utf8'))
  await db.exec(`insert into public.koi_workspaces(id,name) values ('${workspace}','Koi prueba'),('${second}','Otro equipo');
    insert into public.koi_workspace_members(workspace_id,user_id,role) values ('${workspace}','${admin}','admin'),('${workspace}','${operator}','operator'),('${second}','${other}','admin');`)
})
after(async () => { await db.close() })

async function asUser<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${user}';`)
  try { return await fn() } finally { await db.exec('reset role; reset request.jwt.claim.sub;') }
}

test('anonymous users cannot read or mutate lists', async () => {
  await db.exec('set role anon')
  try { await assert.rejects(db.query('select * from public.koi_lead_lists'), /permission denied/) }
  finally { await db.exec('reset role') }
})
test('member can create list and trigger writes authoritative audit event', async () => {
  await asUser(admin, async () => {
    const result = await db.query<{ id: string }>(`insert into public.koi_lead_lists(workspace_id,name,request_id,created_by) values ($1,'Arquitectos',$2,$3) returning id`, [workspace, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', admin])
    listId = result.rows[0]!.id
    const events = await db.query<{ actor_id: string }>('select actor_id from public.koi_audit_events')
    assert.equal(events.rows[0]?.actor_id, admin)
  })
})
test('another workspace and a non-member cannot read or update this list', async () => {
  for (const user of [other, outsider]) await asUser(user, async () => {
    assert.equal((await db.query('select * from public.koi_lead_lists')).rows.length, 0)
    assert.equal((await db.query('update public.koi_lead_lists set name = $1 where id = $2 returning id', ['Ataque', listId])).rows.length, 0)
    await assert.rejects(db.query('insert into public.koi_lead_lists(workspace_id,name,request_id) values ($1,$2,gen_random_uuid())', [workspace, 'Invasión']), /row-level security/)
  })
})
test('operators can rename, cannot grant membership, move workspace or forge audit', async () => {
  await asUser(operator, async () => {
    assert.equal((await db.query('update public.koi_lead_lists set name = $1 where id = $2 returning id', ['Arquitectos Tucumán', listId])).rows.length, 1)
    assert.equal((await db.query('select * from public.koi_audit_events')).rows.length, 0)
    await assert.rejects(db.query('update public.koi_workspace_members set role = $1', ['admin']), /permission denied/)
    await assert.rejects(db.query('update public.koi_lead_lists set workspace_id = $1 where id = $2', [second, listId]), /permission denied/)
    await assert.rejects(db.query('insert into public.koi_audit_events default values'), /permission denied/)
    await assert.rejects(db.query('delete from public.koi_lead_lists'), /permission denied/)
  })
})
test('spoofed creator, duplicate name, duplicate request and invalid name are rejected', async () => {
  await asUser(admin, async () => {
    await assert.rejects(db.query('insert into public.koi_lead_lists(workspace_id,name,request_id,created_by) values ($1,$2,gen_random_uuid(),$3)', [workspace, 'Falsa', other]), /row-level security/)
    await assert.rejects(db.query('insert into public.koi_lead_lists(workspace_id,name,request_id) values ($1,$2,gen_random_uuid())', [workspace, 'ARQUITECTOS TUCUMÁN']), /duplicate key/)
    await assert.rejects(db.query('insert into public.koi_lead_lists(workspace_id,name,request_id) values ($1,$2,$3)', [workspace, 'Otro nombre', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']), /duplicate key/)
    await assert.rejects(db.query('insert into public.koi_lead_lists(workspace_id,name,request_id) values ($1,$2,gen_random_uuid())', [workspace, '  ']), /check constraint/)
  })
})
test('revocation takes effect without changing the JWT', async () => {
  await db.query('delete from public.koi_workspace_members where user_id = $1', [operator])
  await asUser(operator, async () => {
    assert.equal((await db.query('select * from public.koi_lead_lists')).rows.length, 0)
    assert.equal((await db.query('update public.koi_lead_lists set name = $1 where id = $2 returning id', ['Revocado', listId])).rows.length, 0)
  })
})
