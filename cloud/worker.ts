// ============================================================
//  SUNDOWN RUN II ONLINE - the Cloudflare Worker
// ------------------------------------------------------------
//  Serves the game for players in different houses:
//
//    /            the production build (dist/), straight from
//                 Cloudflare's static assets: the Worker doesn't even run
//    /relay       the multiplayer relay: a WebSocket handed to the one
//                 room (room.ts, a Durable Object)
//    /api/report  "Report a problem" and /api/tracks (Share, Shared
//    /api/tracks  tracks) only work in the game at home (they need the
//                 GitHub key on that computer). Here they answer
//                 "not set up" in the shapes the game understands, so
//                 the screens say so plainly instead of waiting or erroring.
//
//  Cloudflare Access sits in front of all of it (cloud/README.md).
// ============================================================

import pkg from '../package.json'
import type { ReportInfo, ReportResult } from '../src/ui/report/protocol'
import type { SharedListResult, ShareResult } from '../src/editor/share/protocol'
import type { Env } from './room'

export { Room } from './room'

const REPORT_OFF = "Reporting doesn't work in the online game. Tell Dad what happened, or report it from the game at home."
const SHARE_OFF = "Shared tracks only work in the game at home, not the online one. Your own tracks still work."

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

function tracksAnswer(request: Request): Response {
  if (request.method === 'GET') {
    const list: SharedListResult = { status: 'unavailable', reason: 'refused', message: SHARE_OFF, ready: false, waiting: 0 }
    return json(list)
  }
  if (request.method === 'POST') {
    const answer: ShareResult = { status: 'rejected', reason: 'invalid', message: SHARE_OFF }
    return json(answer)
  }
  return json({ error: 'GET or POST only' }, 405)
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
    if (pathname === '/api/tracks') return tracksAnswer(request)
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
