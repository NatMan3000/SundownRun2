// ============================================================
//  FAKE GITHUB - a pretend GitHub for testing the post office
// ------------------------------------------------------------
//  Report a problem and track sharing post to GitHub, and the game's
//  repository is public, so tests must never touch the real one. This
//  is a small stand-in that answers the same calls the same way:
//
//    POST  /repos/:owner/:repo/issues          make an issue
//    GET   /repos/:owner/:repo/issues          list (labels, state, sort, direction, per_page)
//    GET   /repos/:owner/:repo/issues/:n       one issue
//    PATCH /repos/:owner/:repo/issues/:n       edit one (title, body, state, labels)
//    GET   /repos/:owner/:repo/labels/:name    is there a label?
//    POST  /repos/:owner/:repo/labels          make a label
//
//  Like the real GitHub it silently drops labels sent by a key without
//  push access ("Only users with push access can set labels for new
//  issues. Labels are silently dropped otherwise."), says 401 to an
//  unknown key, limits reads without a key (403 "API rate limit
//  exceeded", x-ratelimit-remaining: 0), and lists pull requests as
//  issues too.
//
//  Point the game at it with SR2_ISSUES_API=http://127.0.0.1:<port>.
//  Tests drive it directly (startFakeGithub), or run it on its own:
//
//    bun server/fakeGithub.ts --port 47231 --token <fake-key>[:nopush]
//
//  and look at or change what it holds over plain HTTP:
//    GET  /__fake/state                     every issue, label and request
//    POST /__fake/fail    { status, message, times }   the next calls fail
//    POST /__fake/issue   { title, body, labels, pull } add an issue as a stranger would
//    POST /__fake/edit    { number, body?, state? }    change one as someone on the website would
//    POST /__fake/limit   { remaining }                reads without a key left this hour
// ============================================================

export interface FakeIssue {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: { name: string }[]
  created_at: string
  updated_at: string
  html_url: string
  user: { login: string }
  pull_request?: { url: string }
}

export interface FakeRequest {
  method: string
  path: string
  /** Which key was used ('none' without one). Never the key itself. */
  key: string
}

export interface FakeGithub {
  url: string
  port: number
  issues: FakeIssue[]
  labels: Set<string>
  requests: FakeRequest[]
  /** Reads without a key left (GitHub allows 60 an hour). */
  limit: { remaining: number }
  /** The next `times` API calls fail with this status. */
  failNext: (status: number, message: string, times?: number) => void
  addIssue: (i: { title: string; body: string; labels?: string[]; pull?: boolean; login?: string }) => FakeIssue
  stop: () => void
}

/** Keys the fake knows, and whether each one's owner has push access. */
export type FakeKeys = Record<string, { push: boolean; login: string }>

export function startFakeGithub(opts: { port?: number; keys: FakeKeys; repo?: string }): FakeGithub {
  const repo = opts.repo ?? 'NatMan3000/SundownRun2'
  const issues: FakeIssue[] = []
  const labels = new Set<string>()
  const requests: FakeRequest[] = []
  const limit = { remaining: 60 }
  let fail: { status: number; message: string; times: number } | null = null
  let clock = Date.parse('2026-10-04T00:00:00Z')
  const now = () => new Date((clock += 1000)).toISOString()

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

  const addIssue: FakeGithub['addIssue'] = (i) => {
    const number = issues.length + 1
    const t = now()
    const issue: FakeIssue = {
      number,
      title: i.title,
      body: i.body,
      state: 'open',
      labels: (i.labels ?? []).map((name) => ({ name })),
      created_at: t,
      updated_at: t,
      html_url: `https://github.com/${repo}/issues/${number}`,
      user: { login: i.login ?? 'stranger' },
    }
    if (i.pull) issue.pull_request = { url: `https://api.github.com/repos/${repo}/pulls/${number}` }
    for (const l of i.labels ?? []) labels.add(l)
    issues.push(issue)
    return issue
  }

  /** Labels a caller may set: all of them with push access (missing ones are made), none without. */
  const keepLabels = (asked: unknown, push: boolean): { name: string }[] | null => {
    if (!push || !Array.isArray(asked)) return null
    const out: { name: string }[] = []
    for (const l of asked) {
      if (typeof l !== 'string') continue
      labels.add(l)
      out.push({ name: l })
    }
    return out
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      // ---- the test controls
      if (path.startsWith('/__fake/')) {
        const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
        if (path === '/__fake/state') return json(200, { issues, labels: [...labels], requests, limit })
        if (path === '/__fake/fail') {
          fail = { status: Number(body.status), message: String(body.message ?? 'fake failure'), times: Number(body.times ?? 1) }
          return json(200, { ok: true })
        }
        if (path === '/__fake/issue') {
          return json(201, addIssue({ title: String(body.title ?? ''), body: String(body.body ?? ''), labels: (body.labels as string[]) ?? [], pull: !!body.pull }))
        }
        if (path === '/__fake/edit') {
          const issue = issues.find((i) => i.number === Number(body.number))
          if (!issue) return json(404, { message: 'Not Found' })
          if (typeof body.body === 'string') issue.body = body.body
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state
          issue.updated_at = now()
          return json(200, issue)
        }
        if (path === '/__fake/limit') {
          limit.remaining = Number(body.remaining)
          return json(200, limit)
        }
        return json(404, { message: 'no such fake control' })
      }

      // ---- the API
      const auth = req.headers.get('authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      const who = token ? opts.keys[token] : null
      requests.push({ method: req.method, path: path + url.search, key: token ? (who ? who.login : 'unknown') : 'none' })
      if (fail && fail.times > 0) {
        fail.times--
        return json(fail.status, { message: fail.message })
      }
      if (token && !who) return json(401, { message: 'Bad credentials' })
      if (!token) {
        if (limit.remaining <= 0) return json(403, { message: 'API rate limit exceeded for 127.0.0.1.' }, { 'x-ratelimit-remaining': '0' })
        limit.remaining--
      }
      const base = `/repos/${repo}`
      if (!path.startsWith(base)) return json(404, { message: 'Not Found' })
      const rest = path.slice(base.length)
      const writing = req.method === 'POST' || req.method === 'PATCH'
      if (writing && !who) return json(401, { message: 'Requires authentication' })
      const body = writing ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) : null
      if (writing && !body) return json(400, { message: 'Problems parsing JSON' })

      if (rest === '/issues' && req.method === 'POST' && body) {
        if (typeof body.title !== 'string' || !body.title) return json(422, { message: 'Validation Failed' })
        if (typeof body.body === 'string' && body.body.length > 65536) return json(422, { message: 'Validation Failed: body is too long (maximum is 65536 characters)' })
        const issue = addIssue({ title: body.title, body: String(body.body ?? ''), login: who!.login })
        issue.labels = keepLabels(body.labels, who!.push) ?? []
        return json(201, issue)
      }
      if (rest === '/issues' && req.method === 'GET') {
        const want = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean)
        const state = url.searchParams.get('state') ?? 'open'
        const sort = url.searchParams.get('sort') ?? 'created'
        const desc = (url.searchParams.get('direction') ?? 'desc') === 'desc'
        const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30))
        const list = issues
          .filter((i) => state === 'all' || i.state === state)
          .filter((i) => want.every((w) => i.labels.some((l) => l.name === w)))
          .sort((a, b) => {
            const k = sort === 'updated' ? 'updated_at' : 'created_at'
            const d = a[k].localeCompare(b[k]) || a.number - b.number
            return desc ? -d : d
          })
          .slice(0, perPage)
        return json(200, list)
      }
      const one = /^\/issues\/(\d+)$/.exec(rest)
      if (one) {
        const issue = issues.find((i) => i.number === Number(one[1]))
        if (!issue) return json(404, { message: 'Not Found' })
        if (req.method === 'GET') return json(200, issue)
        if (req.method === 'PATCH' && body) {
          if (!who!.push && issue.user.login !== who!.login) return json(403, { message: 'Must have admin rights to Repository.' })
          if (typeof body.title === 'string') issue.title = body.title
          if (typeof body.body === 'string') {
            if (body.body.length > 65536) return json(422, { message: 'Validation Failed' })
            issue.body = body.body
          }
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state
          const kept = keepLabels(body.labels, who!.push)
          if (kept) issue.labels = kept
          issue.updated_at = now()
          return json(200, issue)
        }
      }
      const label = /^\/labels\/(.+)$/.exec(rest)
      if (label && req.method === 'GET') {
        const name = decodeURIComponent(label[1])
        return labels.has(name) ? json(200, { name }) : json(404, { message: 'Not Found' })
      }
      if (rest === '/labels' && req.method === 'POST' && body) {
        if (!who!.push) return json(403, { message: 'Resource not accessible by personal access token' })
        const name = String(body.name ?? '')
        if (labels.has(name)) return json(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] })
        labels.add(name)
        return json(201, { name, color: body.color, description: body.description })
      }
      return json(404, { message: 'Not Found' })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    issues,
    labels,
    requests,
    limit,
    failNext: (status, message, times = 1) => {
      fail = { status, message, times }
    },
    addIssue,
    stop: () => server.stop(true),
  }
}

// Run on its own: bun server/fakeGithub.ts --port 47231 --token <fake-key>[:nopush] ...
if (import.meta.main) {
  const args = process.argv.slice(2)
  const keys: FakeKeys = {}
  let port = 47231
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i])
    else if (args[i] === '--token') {
      const [key, kind] = String(args[++i]).split(':')
      keys[key] = { push: kind !== 'nopush', login: kind === 'nopush' ? 'helper' : 'owner' }
    }
  }
  const fake = startFakeGithub({ port, keys })
  console.log(`fake GitHub on ${fake.url} (${Object.keys(keys).length} keys)`)
}
