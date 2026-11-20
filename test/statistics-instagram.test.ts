import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstagramStatistics } from '../src/statistics/instagram.ts'
import { createZernioClient } from '../src/inbox/provider.ts'

const accountId = 'ig-fixture'
const now = () => new Date('2026-11-20T17:00:00Z')
const input = { accountId, from: '2026-11-01', to: '2026-11-10' }
const json = (value: unknown, status = 200) => Response.json(value, { status })
const healthy = { accountId, platform: 'instagram', permissions: { canFetchAnalytics: true } }
type Bucket = { date: string; value: number }
const examples: Bucket[] = [
  { date: '2026-10-31', value: 100 }, { date: '2026-11-01', value: 104 }, { date: '2026-11-10', value: 92 },
  { date: '2026-11-19', value: 112 },
]
function response(url: URL, metrics: Record<string, unknown>, extra = {}) {
  return json({ accountId, platform: 'instagram', success: true, metricType: url.searchParams.get('metricType'),
    dateRange: { since: url.searchParams.get('fromDate'), until: url.searchParams.get('toDate') }, metrics, ...extra })
}
type Handler = (url: URL) => Response | undefined
function fixture(override: Handler = () => undefined) {
  const calls: URL[] = []
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(String(request))
    assert.equal(url.origin, 'https://zernio.com')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test')
    calls.push(url)
    const custom = override(url)
    if (custom) return custom
    if (url.pathname.endsWith('/health')) return json(healthy)
    assert.equal(url.searchParams.get('accountId'), accountId)
    if (url.pathname.endsWith('/account-insights')) return response(url, {
      reach: { total: 111 }, views: { total: 452 }, total_interactions: { total: 0 },
    })
    assert.ok(url.pathname.endsWith('/follower-history'))
    return response(url, { follower_count: { values: examples.filter(p =>
      p.date >= url.searchParams.get('fromDate')! && p.date <= url.searchParams.get('toDate')!) } })
  }
  return { read: createInstagramStatistics('test', fetcher, now), calls }
}

test('Instagram reads unique reach and genuine zeros for the exact period; current followers are independent', async () => {
  const { read, calls } = fixture()
  assert.deepEqual(await read(input), {
    status: 'ok', reach: 111, views: 452, interactions: 0, followers: 112, followersAsOf: '2026-11-19',
    followerChange: -8, followerCoverage: { from: '2026-11-01', to: '2026-11-10' },
    rangeLimited: false, issue: null, updatedAt: now().toISOString(),
  })
  assert.equal(calls.filter(c => c.pathname.endsWith('/account-insights')).length, 1)
  assert.equal(calls.find(c => c.pathname.endsWith('/account-insights'))!.searchParams.get('metricType'), 'total_value')
})

test('Snapshots starting late or missing the final day expose coverage and no invented change', async () => {
  const { read } = fixture()
  const result = await read({ accountId, from: '2026-10-24', to: '2026-11-13' })
  assert.equal(result.followerChange, null)
  assert.deepEqual(result.followerCoverage, { from: '2026-10-31', to: '2026-11-10' })
  assert.equal(result.status, 'partial')
  assert.equal(result.followers, 112)
})

test('A Facebook Login range cap splits additive metrics into disjoint periods without summing reach', async () => {
  const { read, calls } = fixture(url => {
    if (!url.pathname.endsWith('/account-insights')) return
    if (url.searchParams.get('metrics')!.includes('reach')) return json({ error: 'Max 30 days' }, 400)
    return response(url, { views: { total: 22 }, total_interactions: { total: 3 } })
  })
  const result = await read({ accountId, from: '2026-10-01', to: '2026-11-10' })
  assert.deepEqual([result.reach, result.views, result.interactions, result.rangeLimited], [null,44,6,true])
  const ranges = calls.filter(c => c.searchParams.get('metrics') === 'views,total_interactions')
  assert.deepEqual(ranges.map(c => [c.searchParams.get('fromDate'), c.searchParams.get('toDate')]),
    [['2026-10-01','2026-10-30'], ['2026-10-31','2026-11-10']])
})

test('A longer supported Instagram Login period returns the provider reach and keeps missing metrics null', async () => {
  const { read } = fixture(url => url.pathname.endsWith('/account-insights')
    ? response(url, { reach: { total: 72 }, total_interactions: { total: 0 } },
      { unavailableMetrics: [{ metric:'views', reason:'no_data' }] }) : undefined)
  const result = await read({ accountId, from:'2026-09-24', to:'2026-11-13' })
  assert.equal(result.reach, 72)
  assert.equal(result.rangeLimited, false)
  assert.equal(result.views, null)
  assert.equal(result.interactions, 0)
})

test('Missing IG consent stops provider reads and a generic denied/invalid API key is not a reconnect signal', async () => {
  const blocked = fixture(url => url.pathname.endsWith('/health')
    ? json({ ...healthy, permissions:{ scopeAreas:{analytics:'not_requested'}, canFetchAnalytics:false } }) : undefined)
  assert.equal((await blocked.read(input)).status, 'permission_required')
  assert.equal(blocked.calls.length, 1)
  const badKey = fixture(() => json({ code:'invalid_credentials' }, 401))
  assert.equal((await badKey.read(input)).issue, 'provider')
  const unlicensed = fixture(url => url.pathname.endsWith('/health') ? undefined : json({ code:'analytics_addon_required' }, 402))
  assert.equal((await unlicensed.read(input)).issue, 'plan')
})

test('An unavailable provider or wrong account response never becomes zero or leaks data', async () => {
  const { read } = fixture(url => url.pathname.endsWith('/health') ? undefined
    : response(url, { reach: { total: 9000 } }, { accountId:'another-tenant' }))
  const result = await read(input)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.issue, 'provider')
  assert.equal(result.reach, null)
  assert.equal(result.followers, null)
  await assert.rejects(read({ ...input, from: '2020-01-01' }), RangeError)
})

test('Inbox OAuth preserves prior Instagram areas and identity, adds analytics, and keeps WhatsApp messaging only', async () => {
  const calls: URL[] = []
  const client = createZernioClient('test', async request => {
    const url = new URL(String(request)); calls.push(url)
    if (url.pathname.endsWith('/accounts/' + accountId)) return json({ account:{
      _id:accountId, profileId:'studio', platform:'instagram', isActive:true, needsReconnection:false,
      scopeAreas:['posting','messaging'],
    } })
    return json({ authUrl:'https://zernio.com/connect' })
  })
  await client.connect('instagram','studio','https://koi.test/finish',accountId)
  assert.deepEqual(calls.at(-1)!.searchParams.get('scopes')!.split(','), ['posting','messaging','analytics'])
  assert.equal(calls.at(-1)!.searchParams.get('reconnectAccountId'), accountId)
  await client.connect('instagram','studio','https://koi.test/finish')
  assert.equal(calls.at(-1)!.searchParams.get('scopes'), 'messaging,analytics')
  await client.connect('whatsapp','studio','https://koi.test/finish')
  assert.equal(calls.at(-1)!.searchParams.get('scopes'), 'messaging')
})
