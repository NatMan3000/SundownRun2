// ============================================================
//  /api/library - the online track library's front door
// ------------------------------------------------------------
//  Every request is checked here before the library (cloud/library.ts)
//  sees it:
//
//    1. it comes from the game's own page (same check as /api/tracks);
//    2. who sent it: the Cloudflare Access login (cloud/access.ts).
//       No valid login, no library; ACCESS_AUD unset, library off;
//    3. a track being saved is a track the game can load: the game's
//       own validator (src/track/validate.ts), the same one the editor
//       and every joiner run, and it fits the size limit.
//
//  Then the one Library object does the rest (ids, owners, caps).
//  The routes and shapes are in src/editor/library/protocol.ts.
// ============================================================

import type { TrackFile } from '../src/track/schema'
import { validateTrack } from '../src/track/validate'
import {
  LIBRARY_LIMITS,
  TRACK_ID_RE,
  type LibraryImportRequest,
  type LibraryRefusal,
  type LibrarySaveRequest,
  cleanPlayerName,
} from '../src/editor/library/protocol'
import { ownerKey, whoIs } from './access'
import { callerProblem, json, readBody } from './http'
import { refuse } from './libraryStore'
import type { Env } from './room'

const STATUS_FOR: Record<LibraryRefusal['code'], number> = {
  off: 503,
  'no-login': 401,
  'not-yours': 403,
  'not-admin': 403,
  'not-found': 404,
  'too-many': 409,
  full: 409,
  'too-big': 413,
  invalid: 400,
  changed: 409,
  error: 500,
}

function answer(body: { status: string; code?: LibraryRefusal['code'] }, okStatus = 200): Response {
  return json(body, body.status === 'ok' ? okStatus : STATUS_FOR[body.code ?? 'error'])
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read and check a JSON body holding a track file: the game's validator decides. */
async function readTrackBody(request: Request): Promise<{ ok: true; body: Record<string, unknown>; file: TrackFile } | { ok: false; refusal: LibraryRefusal }> {
  const text = await readBody(request, LIBRARY_LIMITS.request)
  if (text === null) return { ok: false, refusal: refuse('too-big', `That track is too big to save online (the most is ${LIBRARY_LIMITS.trackBytes / 1024} KB).`) }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, refusal: refuse('invalid', "The library couldn't read that request.") }
  }
  if (!isObj(body) || !isObj(body.file)) return { ok: false, refusal: refuse('invalid', 'There was no track in that request.') }
  const checked = validateTrack(body.file)
  if (!checked.ok) {
    const first = checked.errors[0]
    return { ok: false, refusal: refuse('invalid', `That isn't a track the game can load (${first ? `${first.path} ${first.message}`.trim() : 'something in it is wrong'}).`) }
  }
  // Store exactly what was sent (not the filled-in defaults), so every computer builds the identical file.
  return { ok: true, body, file: body.file as unknown as TrackFile }
}

function library(env: Env) {
  return env.LIBRARY.get(env.LIBRARY.idFromName('library'))
}

function isAdmin(env: Env, email: string): boolean {
  return (env.LIBRARY_ADMINS ?? '')
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email)
}

export async function libraryAnswer(request: Request, env: Env): Promise<Response> {
  const refusal = callerProblem(request)
  if (refusal) {
    console.warn(`[library] refused a request from outside the game (${refusal})`)
    return json(refuse('invalid', 'The track library only answers the game itself.'), 403)
  }
  try {
    const who = await whoIs(request, env)
    if (!who.ok) return answer(refuse(who.code, who.message))
    const owner = await ownerKey(who.email)
    const path = new URL(request.url).pathname.replace(/\/+$/, '')
    const method = request.method

    if (path === '/api/library') {
      if (method !== 'GET') return json({ error: 'GET only' }, 405)
      return answer(await library(env).list(owner))
    }

    if (path === '/api/library/tracks') {
      if (method !== 'POST') return json({ error: 'POST only' }, 405)
      const read = await readTrackBody(request)
      if (!read.ok) return answer(read.refusal)
      const name = typeof read.body.playerName === 'string' ? read.body.playerName : ''
      const result = await library(env).create(owner, name, read.file)
      if (result.status === 'ok') console.log(`[library] new track ${result.id}${result.movedFrom ? ` (sent as ${result.movedFrom})` : ''} by ${cleanPlayerName(name) || 'RACER'}`)
      return answer(result, 201)
    }

    const one = /^\/api\/library\/tracks\/([^/]+)$/.exec(path)
    if (one) {
      const id = decodeURIComponent(one[1])
      if (!TRACK_ID_RE.test(id)) return answer(refuse('not-found', "That track isn't in the library."))
      if (method === 'GET') return answer(await library(env).get(owner, id))
      if (method === 'DELETE') return answer(await library(env).remove(owner, id))
      if (method === 'PUT') {
        const read = await readTrackBody(request)
        if (!read.ok) return answer(read.refusal)
        const req = read.body as unknown as Partial<LibrarySaveRequest>
        if (typeof req.baseRev !== 'number' || !Number.isInteger(req.baseRev)) return answer(refuse('invalid', 'That save did not say which version it was made from.'))
        return answer(await library(env).update(owner, typeof req.playerName === 'string' ? req.playerName : '', id, read.file, req.baseRev))
      }
      return json({ error: 'GET, PUT or DELETE only' }, 405)
    }

    if (path === '/api/library/admin/import') {
      if (method !== 'POST') return json({ error: 'POST only' }, 405)
      if (!isAdmin(env, who.email)) {
        console.warn('[library] refused an import from a login that is not in LIBRARY_ADMINS')
        return answer(refuse('not-admin', 'Only the library admin can import tracks.'))
      }
      const read = await readTrackBody(request)
      if (!read.ok) return answer(read.refusal)
      const req = read.body as unknown as Partial<LibraryImportRequest>
      if (typeof req.owner !== 'string' || !req.owner.includes('@')) return answer(refuse('invalid', 'An import needs the owner as a login email.'))
      const result = await library(env).create(await ownerKey(req.owner), typeof req.ownerName === 'string' ? req.ownerName : '', read.file)
      if (result.status === 'ok') console.log(`[library] imported ${result.id} for ${cleanPlayerName(String(req.ownerName ?? '')) || 'RACER'}`)
      return answer(result, 201)
    }

    return answer(refuse('not-found', 'There is nothing at that address.'))
  } catch (err) {
    console.error('[library] a library request failed inside the Worker', err)
    return answer(refuse('error', 'The track library had a problem with that. Try again in a minute.'))
  }
}
