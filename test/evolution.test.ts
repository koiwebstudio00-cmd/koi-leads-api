import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEvolutionConnection } from '../src/evolution.ts'
import { readConfig } from '../src/config.ts'

const config = { url: 'https://evolution.example.test', apiKey: 'synthetic-secret-never-public', instanceName: 'koi-01', workspaceId: '11111111-1111-4111-8111-111111111111' }
const payload = (state = 'open', instanceName = 'koi-01') => ({ instance: { instanceName, state }, secret: config.apiKey })

test('Evolution reads fixed instance with server key, coalesces requests and expires cache', async () => {
  let calls = 0
  let time = Date.now()
  const client = createEvolutionConnection(config, { now: () => time, fetch: async (url, options) => {
    calls++
    assert.equal(url, 'https://evolution.example.test/instance/connectionState/koi-01')
    assert.equal(options?.method, 'GET')
    assert.equal(new Headers(options?.headers).get('apikey'), config.apiKey)
    assert.equal(options?.redirect, 'error')
    return Response.json(payload())
  } })
  const values = await Promise.all([client.status(), client.status(), client.status()])
  assert.equal(calls, 1)
  assert.equal(values[0]?.state, 'connected')
  assert.equal(JSON.stringify(values).includes(config.apiKey), false)
  await client.status(); assert.equal(calls, 1)
  time += 5001
  await client.status(); assert.equal(calls, 2)
})

test('Evolution distinguishes disconnected and connecting; rejects mismatched or unknown responses', async () => {
  for (const [data, state, issue] of [
    [payload('close'), 'disconnected', undefined],
    [payload('connecting'), 'connecting', undefined],
    [payload('open', 'another-instance'), 'unavailable', 'invalid_response'],
    [payload('unknown'), 'unavailable', 'invalid_response'],
    [{ instance: { instanceName: 'koi-01' } }, 'unavailable', 'invalid_response'],
  ] as const) {
    const result = await createEvolutionConnection(config, { fetch: async () => Response.json(data) }).status()
    assert.equal(result.state, state)
    assert.equal(result.issue, issue)
  }
})

test('Evolution errors do not expose response bodies, keys or transport diagnostics', async () => {
  for (const [status, issue] of [[401, 'credentials'], [403, 'credentials'], [404, 'instance_missing'], [429, 'provider'], [500, 'provider']] as const) {
    const result = await createEvolutionConnection(config, { fetch: async () => Response.json({ secret: config.apiKey }, { status }) }).status()
    assert.equal(result.state, 'unavailable')
    assert.equal(result.issue, issue)
    assert.equal(JSON.stringify(result).includes(config.apiKey), false)
  }
  const result = await createEvolutionConnection(config, { fetch: async () => { throw new Error(config.apiKey) } }).status()
  assert.equal(result.issue, 'network')
  assert.equal(JSON.stringify(result).includes(config.apiKey), false)
})

test('Evolution timeout is bounded and a later failure replaces a previously connected result', async () => {
  let time = Date.now()
  let online = true
  // Keep the event loop alive while AbortSignal.timeout uses an unreferenced timer.
  const timer = setInterval(() => {}, 1000)
  try {
    const client = createEvolutionConnection(config, { now: () => time, timeoutMs: 20, fetch: async (_url, options) => {
      if (online) return Response.json(payload())
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
    } })
    assert.equal((await client.status()).state, 'connected')
    time += 5001; online = false
    assert.equal((await client.status()).state, 'unavailable')
  } finally { clearInterval(timer) }
})

test('Evolution config is optional but rejects partial configuration, insecure URLs and invalid names without secrets', () => {
  const base = { KOI_APP_ORIGIN: 'https://leads.koistudio.com.ar', KOI_SUPABASE_URL: 'https://avqhjbrcbgqhelfkcist.supabase.co', KOI_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_test_only' }
  const env = { ...base, EVOLUTION_PUBLIC_URL: config.url, EVOLUTION_API_KEY: config.apiKey, EVOLUTION_INSTANCE_NAME: config.instanceName, KOI_EVOLUTION_WORKSPACE_ID: config.workspaceId }
  assert.equal(readConfig(base).EVOLUTION_PUBLIC_URL, undefined)
  assert.equal(readConfig(env).EVOLUTION_INSTANCE_NAME, 'koi-01')
  for (const override of [
    { EVOLUTION_API_KEY: '' }, { KOI_EVOLUTION_WORKSPACE_ID: '' },
    { EVOLUTION_PUBLIC_URL: 'http://evolution.test' },
    { EVOLUTION_PUBLIC_URL: `https://${config.apiKey}@example.test` },
    { EVOLUTION_PUBLIC_URL: `${config.url}/manager` },
    { EVOLUTION_PUBLIC_URL: `${config.url}?key=${config.apiKey}` },
    { EVOLUTION_INSTANCE_NAME: '../delete' },
  ]) assert.throws(() => readConfig({ ...env, ...override }), error => error instanceof Error && !error.message.includes(config.apiKey))
})
