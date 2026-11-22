import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { prepare,reconcile } from '../scripts/backoffice-stage.ts'

test('preview, stable identities, isolated parents and atomic conflict handling',async()=>{
  const db = new PGlite()
  try {
    const workspace=randomUUID(), other=randomUUID(), author=randomUUID()
    const clients=[{id:randomUUID()},{id:randomUUID()}]
    const projects=clients.map(c=>({id:randomUUID(),name:'Portal',created_by:author,client_id:c.id,created_at:'2026-06-01'}))
    const snapshot={clients,projects}
    const rows=async()=>(await db.query<{entity:string;metadata:Record<string,unknown>}>('select * from staging order by target_id')).rows
    await prepare(db,'office',workspace,snapshot,false)
    assert.equal((await rows()).length,0)
    await prepare(db,'office',workspace,snapshot,true)
    const first=await rows()
    assert.equal(first.length,4)
    assert.equal(first.filter(r=>r.entity==='projects').every(r=>r.metadata.created_by===author && r.metadata.created_at==='2026-06-01'),true)
    assert.deepEqual(new Set(first.filter(r=>r.entity==='projects').map(r=>r.metadata.client_id)),new Set(clients.map(c=>c.id)))
    await prepare(db,'office',workspace,snapshot,true)
    assert.deepEqual(await rows(),first)
    const failed=await prepare(db,'office',other,{projects},true)
    assert.equal(failed.conflicts.length,2)
    assert.deepEqual(await rows(),first)
    await prepare(db,'office',other,snapshot,true)
    assert.equal((await rows()).length,8)
  } finally {await db.close()}
})
test('conflicting signals require review and do not merge contacts',()=>{
  const client={id:'c',email:'A@EXAMPLE.COM',phone:'+549 381 555 0000'}
  const leads=[{...client,id:'a',phone:null},{...client,id:'b',email:null}]
  assert.deepEqual(reconcile([client],leads),[{clientId:'c',candidates:['a','b'],status:'ambiguous'}])
  assert.equal(reconcile([client],leads.slice(0,1))[0]?.status,'requires_verification')
})
