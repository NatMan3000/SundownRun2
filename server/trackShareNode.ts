// ============================================================
//  SHARE A TRACK - the Node server's door
// ------------------------------------------------------------
//  server/trackShare.ts is the counter and knows nothing about web
//  servers (the online Worker runs it too). This is the Bun/Vite
//  server's side: it checks the caller is the game's own page, turns
//  the request into a plain description, and writes the answer back.
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TrackShare } from './trackShare'

/** What the Node server adds: only the game's own pages may call, and how to read and answer. */
export interface NodeEdge {
  callerProblem: (req: IncomingMessage) => string | null
  readBody: (req: IncomingMessage, max: number) => Promise<string | null>
  reply: (res: ServerResponse, code: number, body: unknown) => void
}

/** The Bun/Vite server's handler: checks the caller, then hands the plain request to respond(). */
export function nodeTrackHandler(share: TrackShare, edge: NodeEdge, warn: (msg: string) => void): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const refusal = edge.callerProblem(req)
    if (refusal) {
      warn(`refused a track request from outside the game (${refusal})`)
      edge.reply(res, 403, { status: 'rejected', reason: 'invalid', message: 'Tracks can only be shared from the game itself.' })
      return
    }
    const out = await share.respond({
      method: req.method ?? 'GET',
      fresh: new URL(req.url ?? '/', 'http://x').searchParams.get('fresh') === '1',
      contentType: String(req.headers['content-type'] ?? ''),
      readBody: (max) => edge.readBody(req, max),
    })
    if (out.allow) res.setHeader('Allow', out.allow)
    if (out.close) res.setHeader('Connection', 'close')
    edge.reply(res, out.code, out.body)
  }
}

