// ============================================================
//  SUNDOWN RUN II ONLINE - the Cloudflare Worker
// ------------------------------------------------------------
//  Serves the game for players in different houses:
//
//    /            the production build (dist/), straight from
//                 Cloudflare's static assets: the Worker doesn't even run
//    /relay       the multiplayer relay: a WebSocket handed to the one
//                 room (room.ts, a Durable Object)
//    /api/tracks  the Shared tracks list (GitHub issues labelled track):
//                 server/trackShare.ts, the same code the game at home
//                 runs. Read only: online, tracks go to the library, so a
//                 share (POST) is refused. The list feeds the one-time
//                 import (scripts/library-import.ts).
//    /api/library the online track library (cloud/libraryApi.ts): every
//                 player's drawn tracks, saved under their Access login
//                 in the Library Durable Object (cloud/library.ts)
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
import { callerProblem, json, readBody } from './http'
import { libraryAnswer } from './libraryApi'

export { Room } from './room'
export { Library } from './library'

const SHARE_OFF = "Sharing to GitHub only works in the game at home. Online, your tracks save to the track library by themselves: everyone sees them in Everyone's tracks."
const REPORT_OFF = "Reporting doesn't work in the online game. Tell Dad what happened, or report it from the game at home."

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

async function tracksAnswer(request: Request, env: Env): Promise<Response> {
  const refusal = callerProblem(request)
  if (refusal) {
    console.warn(`[share] refused a track request from outside the game (${refusal})`)
    const answer: ShareResult = { status: 'rejected', reason: 'invalid', message: 'Tracks can only be shared from the game itself.' }
    return json(answer, 403)
  }
  // Online, tracks save to the track library (/api/library), so nothing posts to GitHub from here
  // any more. The list still reads (public issues), for the one-time import (scripts/library-import.ts).
  if (request.method === 'POST') {
    const answer: ShareResult = { status: 'rejected', reason: 'invalid', message: SHARE_OFF }
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
    if (pathname === '/api/library' || pathname.startsWith('/api/library/')) return libraryAnswer(request, env)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
