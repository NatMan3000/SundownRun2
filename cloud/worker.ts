// ============================================================
//  SUNDOWN RUN II ONLINE - the Cloudflare Worker
// ------------------------------------------------------------
//  Serves the game for players in different houses:
//
//    /            the production build (dist/), straight from
//                 Cloudflare's static assets: the Worker doesn't even run
//    /relay       the multiplayer relay: a WebSocket handed to the one
//                 room (room.ts, a Durable Object)
//    /api/tracks  Share and Shared tracks: server/trackShare.ts, the same
//                 code the game at home runs, posting to GitHub with the
//                 GITHUB_TOKEN secret (cloud/README.md). No secret: it says
//                 sharing isn't switched on.
//    /api/report  "Report a problem" only works in the game at home (it
//                 queues reports on that computer's disk). Here it answers
//                 "not set up" in the shape the game understands, so the
//                 screen says so plainly instead of waiting or erroring.
//
//  Cloudflare Access sits in front of all of it (cloud/README.md).
// ============================================================

import pkg from '../package.json'
import type { ReportInfo, ReportResult } from '../src/ui/report/protocol'
import type { ShareResult } from '../src/editor/share/protocol'
import { REPORT_REPO } from '../src/ui/report/protocol'
import { createTrackShare, githubCall, type TrackShare } from '../server/trackShare'
import type { Env } from './room'

export { Room } from './room'

const REPORT_OFF = "Reporting doesn't work in the online game. Tell Dad what happened, or report it from the game at home."

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

function reportAnswer(request: Request): Response {
  if (request.method === 'GET') {
    const info: ReportInfo = { ready: false, version: pkg.version, commit: 'online', changed: [], waiting: 0, unavailable: REPORT_OFF }
    return json(info)
  }
  if (request.method === 'POST') {
    const answer: ReportResult = { status: 'rejected', reason: 'invalid', message: REPORT_OFF }
    return json(answer)
  }
  return json({ error: 'GET or POST only' }, 405)
}

// Track sharing: the same brain as the game at home (server/trackShare.ts), with a
// post office that has the key from the GITHUB_TOKEN secret and no disk. Its memory
// (the minute-long list, the 6-shares-in-10-minutes limit) lives in this isolate, so it
// is lost when Cloudflare recycles it and is per-isolate, not global; both only soften
// load on GitHub, and GitHub stays the source of truth.
let shareCounter: { api: string; share: TrackShare } | null = null

function sharing(env: Env): TrackShare {
  const api = githubApi(env.SR2_ISSUES_API)
  if (shareCounter?.api === api) return shareCounter.share
  const share = createTrackShare({
    repo: REPORT_REPO,
    log: (m) => console.log(`[share] ${m}`),
    warn: (m) => console.warn(`[share] ${m}`),
    // Read per request, so a new secret needs nothing more than the deploy that carries it.
    readToken: async () => cleanToken(currentEnv?.GITHUB_TOKEN ?? ''),
    github: (method, path, token, body) => githubCall({ api, repo: REPORT_REPO }, method, path, token, body),
  })
  shareCounter = { api, share }
  return share
}
let currentEnv: Env | null = null

function githubApi(raw: string | undefined): string {
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol === 'http:' || u.protocol === 'https:') return raw.replace(/\/+$/, '')
    } catch {
      // not an address: the real GitHub
    }
  }
  return 'https://api.github.com'
}

/** A GitHub key is one word of letters, digits and underscores (the same check as the home server). */
function cleanToken(s: string): string | null {
  const t = s.trim().replace(/^["']+|["']+$/g, '').trim()
  return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null
}

/** Only the game's own page may call (Access already gates who can reach the Worker). */
function callerProblem(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return `page from ${origin}`
    } catch {
      return 'unreadable origin'
    }
  }
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return `${site} request`
  return null
}

/** Read the body as text, or null if it is bigger than `max` bytes. */
async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

async function tracksAnswer(request: Request, env: Env): Promise<Response> {
  const refusal = callerProblem(request)
  if (refusal) {
    console.warn(`[share] refused a track request from outside the game (${refusal})`)
    const answer: ShareResult = { status: 'rejected', reason: 'invalid', message: 'Tracks can only be shared from the game itself.' }
    return json(answer, 403)
  }
  currentEnv = env
  try {
    const out = await sharing(env).respond({
      method: request.method,
      fresh: new URL(request.url).searchParams.get('fresh') === '1',
      contentType: request.headers.get('content-type') ?? '',
      readBody: (max) => readBody(request, max),
    })
    const res = json(out.body, out.code)
    if (out.allow) res.headers.set('Allow', out.allow)
    return res
  } catch (err) {
    console.error('[share] a track request failed inside the Worker', err)
    const answer: ShareResult = { status: 'rejected', reason: 'invalid', message: 'The game server had a problem with that. Try again.' }
    return json(answer, 500)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/relay') {
      // One room for everyone.
      const room = env.ROOM.get(env.ROOM.idFromName('main'))
      return room.fetch(request)
    }
    if (pathname === '/api/report') return reportAnswer(request)
    if (pathname === '/api/tracks') return tracksAnswer(request, env)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
