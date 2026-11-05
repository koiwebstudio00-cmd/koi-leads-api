import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createApp } from '../src/app.ts'
import { ApiError, type UserStore } from '../src/store.ts'
import { readConfig } from '../src/config.ts'

const row = { id: '11111111-1111-4111-8111-111111111111', name: 'Prueba', description: '', created_at: '2026-11-04T12:00:00Z', updated_at: '2026-11-04T12:00:00Z' }
test('API authenticates requests, validates bodies and preserves server-derived workspace', async () => {
  let writes = 0
  const store: UserStore = { imports: { recent: async () => [], save: async () => ({ revision:1 }), check: async () => ({ newContacts:0,existingContacts:0,blocked:0 }), stage: async () => { throw new Error('unused') }, draft: async () => { throw new Error('unused') }, commit: async () => { throw new Error('unused') }, contacts: async () => ({ leads: [], total: 0 }), report: async () => [] }, userId: row.id, membership: { workspace_id: row.id, role: 'admin', workspace_name: 'Koi' }, list: async () => ({ lists: [row], total: 1 }), create: async input => { writes++; return { ...row, ...input } }, update: async (_id, input) => ({ ...row, ...input }) }
  let evolutionCalls = 0
  const server = createApp({ origin: 'http://localhost:5173', evolution: { workspaceId: row.id, status: async () => { evolutionCalls++; return { state: 'connected', instanceName: 'koi-01', checkedAt: new Date().toISOString() } } }, authorize: async token => { if (token !== 'valid') throw new ApiError(401, 'Sesión inválida'); return store } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const headers = { Authorization: 'Bearer valid', 'Content-Type': 'application/json', 'Idempotency-Key': row.id }
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200)
    assert.equal((await fetch(`${url}/api/lead-lists`)).status, 401)
    assert.equal((await fetch(`${url}/api/lead-lists`, { headers: { Authorization: 'Bearer forged' } })).status, 401)
    assert.equal((await fetch(`${url}/api/lead-lists`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403)
    assert.equal((await fetch(`${url}/api/workspace`, { headers })).status, 200)
    const connection = `${url}/api/integrations/evolution/status`
    assert.equal((await fetch(connection)).status, 401)
    assert.equal((await fetch(connection, { headers: { Authorization: 'Bearer forged' } })).status, 401)
    assert.equal(evolutionCalls, 0)
    store.membership.workspace_id = '22222222-2222-4222-8222-222222222222'
    assert.equal((await fetch(connection, { headers })).status, 403)
    assert.equal(evolutionCalls, 0)
    store.membership.workspace_id = row.id
    store.membership.role = 'operator'
    assert.equal((await (await fetch(connection, { headers })).json()).state, 'connected')
    assert.equal(evolutionCalls, 1)
    assert.equal((await fetch(connection, { method: 'POST', headers })).status, 404)
    store.membership.role = 'admin'
    assert.equal((await fetch(`${url}/api/lead-lists`, { headers })).status, 200)
    assert.equal((await fetch(`${url}/api/lead-lists?page=-1`, { headers })).status, 422)
    assert.equal((await fetch(`${url}/api/lead-lists`, { method: 'POST', headers, body: JSON.stringify({ name: 'Valid', workspace_id: row.id }) })).status, 422)
    assert.equal((await fetch(`${url}/api/lead-lists`, { method: 'POST', headers, body: '{' })).status, 400)
    assert.equal((await fetch(`${url}/api/lead-lists`, { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(20_000) }) })).status, 413)
    const result = await fetch(`${url}/api/lead-lists`, { method: 'POST', headers, body: JSON.stringify({ name: '  Arquitectos  ' }) })
    assert.equal(result.status, 201); assert.equal((await result.json()).name, 'Arquitectos'); assert.equal(writes, 1)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
test('server refuses wrong project and privileged keys without exposing values', () => {
  const base = { KOI_APP_ORIGIN: 'http://localhost:5173', KOI_SUPABASE_URL: 'https://avqhjbrcbgqhelfkcist.supabase.co', KOI_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only_not_real' }
  assert.equal(readConfig(base).PORT, 3001)
  assert.throws(() => readConfig({ ...base, KOI_SUPABASE_URL: 'https://other.supabase.co' }), /KOI_SUPABASE_URL/)
  assert.throws(() => readConfig({ ...base, KOI_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_DO_NOT_ECHO' }), error => error instanceof Error && !error.message.includes('DO_NOT_ECHO'))
})
