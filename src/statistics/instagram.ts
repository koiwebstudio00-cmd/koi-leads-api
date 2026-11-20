import { z } from 'zod'

type Dates = { from: string; to: string }
type Input = Dates & { accountId: string }
export type InstagramStatistics = {
  status: 'ok' | 'partial' | 'unavailable' | 'permission_required'
  reach: number | null
  views: number | null
  interactions: number | null
  followers: number | null
  followersAsOf: string | null
  followerChange: number | null
  followerCoverage: { from: string | null; to: string | null }
  rangeLimited: boolean
  updatedAt: string
  issue: 'permission' | 'plan' | 'provider' | 'range' | 'coverage' | null
}

const endpoint = 'https://zernio.com/api/v1/'
const dayMs = 86_400_000
const count = z.number().int().nonnegative()
const scope = z.object({ scope: z.string(), required: z.boolean(), granted: z.boolean() })
const health = z.object({
  accountId: z.string(), platform: z.literal('instagram'),
  tokenStatus: z.object({ valid: z.boolean() }).optional(),
  permissions: z.object({
    canFetchAnalytics: z.boolean().optional(),
    scopeAreas: z.object({ analytics: z.string().optional() }).optional(),
    analytics: z.array(scope).optional(),
  }),
})
const bucket = z.object({ date: z.iso.date(), value: count })
const envelope = z.object({
  accountId: z.string(), platform: z.literal('instagram'), success: z.literal(true),
  dateRange: z.object({ since: z.iso.date(), until: z.iso.date() }),
  metricType: z.enum(['total_value', 'time_series']),
  metrics: z.record(z.string(), z.object({ total: count.optional(), values: z.array(bucket).optional() })),
  unavailableMetrics: z.array(z.object({ metric: z.string(), reason: z.string() })).optional(),
})

class ReportError extends Error {
  readonly status: number
  readonly issue: 'permission' | 'provider' | 'plan'
  constructor(status: number, issue: ReportError['issue']) {
    super('No se pudo consultar Instagram.')
    this.status = status
    this.issue = issue
  }
}

function shift(day: string, offset: number) {
  return new Date(Date.parse(day) + offset * dayMs).toISOString().slice(0, 10)
}

function windows({ from, to }: Dates, length: number) {
  const periods: Dates[] = []
  for (let start = from; start <= to;) {
    const end = shift(start, length - 1)
    periods.push({ from: start, to: end < to ? end : to })
    start = shift(end, 1)
  }
  return periods
}

export function createInstagramStatistics(apiKey: string, fetcher: typeof fetch = fetch, now = () => new Date()) {
  async function get<T>(path: string, query: Record<string, string>, schema: z.ZodType<T>) {
    const url = new URL(path, endpoint)
    url.search = new URLSearchParams(query).toString()
    const response = await fetcher(url, {
      headers: { Authorization: 'Bearer ' + apiKey }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string } | null
      const code = error?.code
      if (response.status === 402 || code === 'analytics_addon_required') throw new ReportError(response.status, 'plan')
      const permission = code === 'insufficient_permissions' || code === 'reconnect_required' || code === 'missing_permissions'
      throw new ReportError(response.status, permission ? 'permission' : 'provider')
    }
    return schema.parse(await response.json())
  }

  return async function read({ accountId, from, to }: Input): Promise<InstagramStatistics> {
    const instant = now()
    const today = instant.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Tucuman' })
    const result: InstagramStatistics = {
      status: 'unavailable', reach: null, views: null, interactions: null, followers: null,
      followerChange: null, followersAsOf: null, followerCoverage: { from: null, to: null },
      rangeLimited: false, issue: null, updatedAt: instant.toISOString(),
    }
    if (!accountId || !z.iso.date().safeParse(from).success || !z.iso.date().safeParse(to).success ||
        from > to || Date.parse(to) - Date.parse(from) > 365 * dayMs) {
      throw new RangeError('El período de Instagram admite entre 1 y 366 días.')
    }
    const end = to < today ? to : today
    const period = { from, to: end }
    const issues = new Set<ReportError['issue']>()
    const record = (error: unknown) => issues.add(error instanceof ReportError ? error.issue : 'provider')

    try {
      const account = await get('accounts/' + encodeURIComponent(accountId) + '/health', {}, health)
      if (account.accountId !== accountId) throw new ReportError(502, 'provider')
      const permissions = account.permissions
      if (account.tokenStatus?.valid === false || permissions.canFetchAnalytics === false ||
          ['missing', 'not_requested'].includes(permissions.scopeAreas?.analytics ?? '') ||
          permissions.analytics?.some(p => p.required && !p.granted)) {
        return { ...result, status: 'permission_required', issue: 'permission' }
      }
    } catch (error) {
      // Some keys may read insights but not run the live health probe. The scoped
      // data endpoints remain authoritative; do not infer missing consent from a 403 alone.
      if (error instanceof ReportError && error.issue === 'permission') {
        return { ...result, status: 'permission_required', issue: 'permission' }
      }
    }

    async function metrics(path: string, wanted: string, range: Dates, mode: 'total_value' | 'time_series') {
      const data = await get('analytics/instagram/' + path, {
        accountId, metrics: wanted, fromDate: range.from, toDate: range.to, metricType: mode,
      }, envelope)
      if (data.accountId !== accountId || data.metricType !== mode ||
          data.dateRange.since !== range.from || data.dateRange.until !== range.to) throw new ReportError(502, 'provider')
      if (data.unavailableMetrics?.some(m => m.reason === 'permission_missing')) issues.add('permission')
      return data.metrics
    }

    async function accountTotals() {
      if (from > end) return
      const days = (Date.parse(end) - Date.parse(from)) / dayMs + 1
      if (days <= 90) {
        try {
          const data = await metrics('account-insights', 'reach,views,total_interactions', period, 'total_value')
          result.reach = data.reach?.total ?? null
          result.views = data.views?.total ?? null
          result.interactions = data.total_interactions?.total ?? null
          return
        } catch (error) {
          if (days <= 30 || !(error instanceof ReportError && error.status === 400)) throw error
        }
      }
      // Facebook Login can cap an account at 30 days. Views and interactions are
      // additive across disjoint windows. Reach counts people and cannot be summed.
      result.rangeLimited = true
      let views: number | null = 0
      let interactions: number | null = 0
      for (const part of windows(period, 30)) {
        const data = await metrics('account-insights', 'views,total_interactions', part, 'total_value')
        views = views !== null && data.views?.total != null ? views + data.views.total : null
        interactions = interactions !== null && data.total_interactions?.total != null ? interactions + data.total_interactions.total : null
      }
      result.views = views
      result.interactions = interactions
    }

    async function followerSamples(range: Dates) {
      const data = await metrics('follower-history', 'follower_count', range, 'time_series')
      return (data.follower_count?.values ?? []).filter(point => point.date >= range.from && point.date <= range.to)
    }
    const byDate = new Map<string, number>()
    const baseline = shift(from, -1)
    const history = windows({ from: baseline, to: end }, 89)
    // A historical date filter must not turn the period-end count into "current".
    const recent = { from: shift(today, -6), to: today }
    async function historySamples() {
      for (const part of history) {
        const points = await followerSamples(part)
        for (const point of points) byDate.set(point.date, point.value)
      }
    }
    async function latestSamples() {
      if (end === today && baseline <= recent.from) return
      const points = await followerSamples(recent)
      for (const point of points) byDate.set(point.date, point.value)
    }
    const requests = await Promise.allSettled([accountTotals(), historySamples(), latestSamples()])
    for (const request of requests) if (request.status === 'rejected') record(request.reason)
    const dates = [...byDate.keys()].sort()
    const covered = dates.filter(day => day >= from && day <= end)
    result.followerCoverage = { from: covered[0] ?? null, to: covered.at(-1) ?? null }
    const last = dates.at(-1)
    if (last && last >= recent.from && last <= today) {
      result.followers = byDate.get(last)!
      result.followersAsOf = last
    }
    const startCount = byDate.get(baseline)
    const endCount = byDate.get(end)
    if (from <= end && startCount !== undefined && endCount !== undefined) result.followerChange = endCount - startCount
    const values = [result.reach, result.views, result.interactions, result.followers, result.followerChange]
    result.issue = issues.has('permission') ? 'permission' : issues.has('plan') ? 'plan' :
      issues.has('provider') ? 'provider' : result.rangeLimited ? 'range' : values.includes(null) ? 'coverage' : null
    if (result.issue === 'permission') result.status = 'permission_required'
    else if (values.every(value => value === null)) result.status = 'unavailable'
    else result.status = result.issue ? 'partial' : 'ok'
    return result
  }
}
