import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthorizer } from '../src/store.ts'

const userId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'
const url = 'https://avqhjbrcbgqhelfkcist.supabase.co'
const key = 'sb_publishable_synthetic_test_only'
const row = { id: requestId, name: 'Arquitectos', description: '', created_at: '2026-11-04T12:00:00Z', updated_at: '2026-11-04T12:00:00Z' }

test('authorizer validates token remotely and uses user-scoped queries and idempotency', async context => {
  let inserted = false
  let writes = 0
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const target = new URL(request.url)
    assert.equal(request.headers.get('authorization'), 'Bearer signed-test-token')
    assert.equal(request.headers.get('apikey'), key)
    const json = (data: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } })
    if (target.pathname === '/auth/v1/user') return json({ id: userId, aud: 'authenticated', is_anonymous: false })
    if (target.pathname === '/rest/v1/koi_workspace_members') {
      assert.equal(target.searchParams.get('user_id'), `eq.${userId}`)
      return json([{ workspace_id: workspaceId, role: 'admin', koi_workspaces: { name: 'Koi' } }])
    }
    assert.equal(target.pathname, '/rest/v1/koi_lead_lists')
    if (request.method === 'POST') {
      const body = await request.json()
      assert.deepEqual(body, { name: 'Arquitectos', description: '', workspace_id: workspaceId, created_by: userId, request_id: requestId })
      inserted = true; writes++
      return json(row)
    }
    assert.equal(target.searchParams.get('workspace_id'), `eq.${workspaceId}`)
    if (target.searchParams.has('request_id')) return json(inserted ? [row] : [])
    assert.equal(target.searchParams.get('offset'), '24')
    assert.equal(target.searchParams.get('limit'), '24')
    assert.equal(target.searchParams.get('name'), 'ilike.%100\\%\\_literal%')
    return json([row], { 'content-range': '24-24/25' })
  })
  const store = await createAuthorizer(url, key)('signed-test-token')
  assert.deepEqual(await store.list(2, '100%_literal'), { lists: [row], total: 25 })
  assert.deepEqual(await store.create({ name: 'Arquitectos', description: '' }, requestId), row)
  assert.deepEqual(await store.create({ name: 'Arquitectos', description: '' }, requestId), row)
  assert.equal(writes, 1)
  await assert.rejects(store.create({ name: 'Different', description: '' }, requestId), { status: 409 })
})

test('rejected auth never queries database', async context => {
  let calls = 0
  context.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(JSON.stringify({ message: 'invalid JWT' }), { status: 401, headers: { 'content-type': 'application/json' } })
  })
  await assert.rejects(createAuthorizer(url, key)('forged'), { status: 401 })
  assert.equal(calls, 1)
})
