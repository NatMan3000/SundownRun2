// ============================================================
//  SHARE A TRACK - the post office's second counter
// ------------------------------------------------------------
//  The road editor's Library shares a track by sending it here, to
//  the game's own server, and this file posts it on GitHub as an
//  issue labelled "track" (src/editor/share/protocol.ts says what the
//  issue looks like). The Library's Shared tracks list reads those
//  issues back through here too.
//
//    GET  /api/tracks            the open "track" issues, newest first
//    GET  /api/tracks?fresh=1    the same, not from the minute-long memory
//    POST /api/tracks            { track, madeBy, world, shareKey, issue } -> share it
//
//  It is the same post office as Report a problem (server/issues.ts
//  creates it and hands it the key, the waiting pile and the safety
//  checks): the same key file, the same reports/pending/ folder, the
//  same words when the key is missing or the internet is off. A share
//  that can't go now waits there and goes with the next report or
//  share that does get through.
//
//  The label, and why only labelled issues are listed. GitHub's docs
//  for "Create an issue" say of `labels`:
//
//    "NOTE: Only users with push access can set labels for new issues.
//     Labels are silently dropped otherwise."
//
//  The game's key belongs to the repository's owner, so its issues keep
//  the label. A stranger can open an issue on the public repository,
//  but can't put the label on it, so it never shows in anybody's Shared
//  tracks. The list asks GitHub for labelled issues only, and checks
//  every one it gets back for the label again. If GitHub ever drops the
//  label from a share, the answer says so (labelMissing).
//
//  Sharing the same track again: the browser remembers a share key
//  (random letters) for each track it shared, and the issue number.
//  The key is written inside the issue, so this file only ever edits an
//  issue that is labelled "track" AND holds the same share key: never a
//  report, never somebody else's track. A closed issue means Dad took
//  the track down; sharing it again then says so instead of putting it
//  back up.
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import { TRACK_FORMAT, TRACK_VERSION, type TrackFile } from '../src/track/schema'
import {
  SHARE_KEY,
  SHARE_LIMITS,
  TRACK_LABEL,
  buildTrackIssue,
  issueHasShareKey,
  oneLine,
  publicTrackFile,
  readTrackIssue,
  type ShareRequest,
  type ShareResult,
  type ShareSavedReason,
  type SharedListResult,
  type SharedTrackItem,
  type TrackIssue,
} from '../src/editor/share/protocol'

// ---------------------------------------------------------------- settings

/** At most this many shares per this long, so a stuck button can't flood GitHub. */
const SHARE_RATE_MAX = 6
const SHARE_RATE_WINDOW_MS = 10 * 60 * 1000
/** The list is remembered this long, so opening the Library again doesn't ask GitHub again. */
const LIST_KEEP_MS = 60_000
/** Refresh asks GitHub at most this often. Without a key GitHub allows 60 asks an hour. */
const LIST_FRESH_MIN_MS = 10_000
/** A failed list is remembered this long before asking again. */
const LIST_FAIL_KEEP_MS = 10_000
/** When looking for a track's old issue without its number, look through this many recent "track" issues. */
const FIND_PAGE = 100
/** The label's colour on GitHub (no #): the game's cyan. */
const LABEL_COLOUR = '19e3ff'
const LABEL_ABOUT = 'A track shared from the road editor. Close the issue to take the track down.'

// ---------------------------------------------------------------- what the post office hands over

/** Where a waiting share came from, kept with it in reports/pending/. */
export interface SavedShare {
  shareKey: string
  number: number | null
}

/** One GitHub call's result. */
export type GithubResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; reason: 'offline' | 'busy' | 'refused'; status: number; detail: string }

/** What server/issues.ts hands this counter (the key, the waiting pile, the safety checks). */
export interface PostOffice {
  repo: string
  log: (msg: string) => void
  warn: (msg: string) => void
  /** The GitHub key, or null when there is none. Never logged. */
  readToken: () => Promise<string | null>
  /** One GitHub REST call (token null for a plain public read). */
  github: (method: string, path: string, token: string | null, body?: unknown) => Promise<GithubResult>
  /** Put a share on the waiting pile; null when the pile is full. */
  keep: (issue: TrackIssue, reason: ShareSavedReason, share: SavedShare) => Promise<{ waiting: number } | null>
  /** Take waiting shares with this share key off the pile (a newer share replaces them). */
  dropWaiting: (shareKey: string) => Promise<number>
  waitingCount: () => Promise<number>
  /** Send whatever is waiting (after something got through). */
  sendWaiting: (why: string) => void
  /** Requests from anywhere but the game's own pages are refused (null = fine). */
  callerProblem: (req: IncomingMessage) => string | null
  readBody: (req: IncomingMessage, max: number) => Promise<string | null>
  reply: (res: ServerResponse, code: number, body: unknown) => void
}

/** Result of sending one share (now, or from the waiting pile). */
export type ShareSend =
  | { ok: true; number: number; url: string; updated: boolean; labelMissing: boolean }
  | { ok: false; takenDown: true; number: number; url: string }
  | { ok: false; takenDown?: false; reason: 'offline' | 'refused'; status: number; detail: string }

export interface TrackShare {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** Send a share that was waiting (server/issues.ts calls this while it empties the pile). */
  sendSaved: (issue: TrackIssue, share: SavedShare, token: string) => Promise<ShareSend>
}

// ---------------------------------------------------------------- the counter

export function createTrackShare(po: PostOffice): TrackShare {
  const recent: number[] = []
  let labelChecked = false
  let listMemory: { at: number; result: SharedListResult } | null = null

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = po.callerProblem(req)
    if (refusal) {
      po.warn(`refused a track request from outside the game (${refusal})`)
      po.reply(res, 403, { status: 'rejected', reason: 'invalid', message: 'Tracks can only be shared from the game itself.' })
      return
    }
    if (req.method === 'GET') {
      const fresh = new URL(req.url ?? '/', 'http://x').searchParams.get('fresh') === '1'
      po.reply(res, 200, await listShared(fresh))
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      po.reply(res, 405, { status: 'rejected', reason: 'invalid', message: 'Use GET or POST.' })
      return
    }
    // A JSON content type also makes a browser ask first (CORS) before another website can post here.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      po.warn('refused a share that was not sent as JSON')
      po.reply(res, 415, { status: 'rejected', reason: 'invalid', message: 'A share must be JSON.' })
      return
    }
    const raw = await po.readBody(req, SHARE_LIMITS.request)
    if (raw === null) {
      po.warn(`refused a share bigger than ${SHARE_LIMITS.request} bytes`)
      res.setHeader('Connection', 'close')
      answer(res, 413, { status: 'rejected', reason: 'too-big', message: TOO_BIG })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      po.warn(`refused a share that was not readable JSON (${errText(err)})`)
      answer(res, 400, { status: 'rejected', reason: 'invalid', message: 'That share could not be read.' })
      return
    }
    const share = checkShare(parsed)
    if (typeof share === 'string') {
      po.warn(`refused a share: ${share}`)
      answer(res, 400, { status: 'rejected', reason: 'invalid', message: `That track could not be shared: ${share}.` })
      return
    }
    const issue = buildTrackIssue(publicTrackFile(share.track, share.madeBy), share.world, share.shareKey)
    if (!issue) {
      po.warn(`refused to share "${share.track.name}": its issue would be over GitHub's ${SHARE_LIMITS.body} letters`)
      answer(res, 413, { status: 'rejected', reason: 'too-big', message: TOO_BIG })
      return
    }

    const now = Date.now()
    while (recent.length && now - recent[0] > SHARE_RATE_WINDOW_MS) recent.shift()
    if (recent.length >= SHARE_RATE_MAX) {
      const waitMin = Math.max(1, Math.ceil((SHARE_RATE_WINDOW_MS - (now - recent[0])) / 60_000))
      po.warn(`refused a share: ${SHARE_RATE_MAX} already in the last ${SHARE_RATE_WINDOW_MS / 60_000} minutes`)
      answer(res, 429, {
        status: 'rejected',
        reason: 'too-many',
        message: `That's ${SHARE_RATE_MAX} shares in ${SHARE_RATE_WINDOW_MS / 60_000} minutes. Have a break and share it again in ${waitMin} ${waitMin === 1 ? 'minute' : 'minutes'}.`,
      })
      return
    }
    recent.push(now)

    const saved: SavedShare = { shareKey: share.shareKey, number: share.issue }
    const token = await po.readToken()
    if (!token) {
      await keepAndAnswer(res, issue, 'no-token', saved, 'sharing is not switched on here yet (no github-token.txt in the game folder)')
      return
    }
    const sent = await sendShare(issue, saved, token)
    if (!sent.ok && sent.takenDown) {
      po.warn(`did not share "${share.track.name}" again: its issue #${sent.number} is closed (taken down)`)
      answer(res, 409, {
        status: 'rejected',
        reason: 'taken-down',
        message: `This track was taken down on GitHub (its post, #${sent.number}, is closed), so it wasn't shared again. Ask Dad if it should go back up.`,
      })
      return
    }
    if (!sent.ok) {
      await keepAndAnswer(res, issue, sent.reason, saved, sent.detail)
      return
    }
    // This share replaces any older copy of it still waiting on this computer.
    const dropped = await po.dropWaiting(share.shareKey)
    if (dropped) po.log(`dropped ${dropped} older waiting ${dropped === 1 ? 'copy' : 'copies'} of this share`)
    listMemory = null
    po.log(`${sent.updated ? 'updated' : 'shared'} "${share.track.name}": issue #${sent.number} ${sent.url}`)
    if (sent.labelMissing) po.warn(`GitHub left the "${TRACK_LABEL}" label off issue #${sent.number}, so it won't show in Shared tracks (the key's owner needs push access to the repository)`)
    po.sendWaiting('a track was shared')
    answer(res, 200, { status: 'sent', number: sent.number, url: sent.url, updated: sent.updated, labelMissing: sent.labelMissing })
  }

  function answer(res: ServerResponse, code: number, body: ShareResult): void {
    po.reply(res, code, body)
  }

  async function keepAndAnswer(res: ServerResponse, issue: TrackIssue, reason: ShareSavedReason, saved: SavedShare, detail: string): Promise<void> {
    await po.dropWaiting(saved.shareKey)
    const kept = await po.keep(issue, reason, saved)
    if (!kept) {
      po.warn(`could not keep a share: the waiting pile is full (${detail})`)
      answer(res, 507, {
        status: 'rejected',
        reason: 'full',
        message: 'There are already too many reports and tracks waiting on this computer. Ask Dad to switch reporting on so they can send.',
      })
      return
    }
    po.warn(`kept a share on this computer: ${detail}. It goes up as soon as reporting works.`)
    answer(res, 200, { status: 'saved', reason, waiting: kept.waiting, detail })
  }

  // ---------------------------------------------------------------- sending

  async function sendShare(issue: TrackIssue, share: SavedShare, token: string): Promise<ShareSend> {
    await ensureLabel(token)
    const found = await findIssue(share, token)
    if (!found.ok) return found
    const old = found.issue
    if (old && old.state === 'closed') return { ok: false, takenDown: true, number: old.number, url: old.url }
    if (old) {
      // No labels in the edit: GitHub would replace the issue's labels with them.
      const edited = await po.github('PATCH', `/repos/${po.repo}/issues/${old.number}`, token, { title: issue.title, body: issue.body })
      if (edited.ok) return sentFrom(edited.data, true, old.number)
      if (edited.status !== 404 && edited.status !== 410) return writeFailure(edited)
      po.warn(`issue #${old.number} has gone from GitHub; sharing the track as a new one`)
    }
    const made = await po.github('POST', `/repos/${po.repo}/issues`, token, issue)
    if (!made.ok) return writeFailure(made)
    return sentFrom(made.data, false, 0)
  }

  function sentFrom(data: unknown, updated: boolean, fallbackNumber: number): ShareSend {
    const d = data as { number?: unknown; html_url?: unknown } | null
    const number = typeof d?.number === 'number' && Number.isInteger(d.number) ? d.number : fallbackNumber
    const url = typeof d?.html_url === 'string' ? d.html_url : `https://github.com/${po.repo}/issues`
    return { ok: true, number, url, updated, labelMissing: !hasTrackLabel(data) }
  }

  /** The track's old issue, if there is one: labelled "track" and holding the same share key. */
  async function findIssue(share: SavedShare, token: string): Promise<{ ok: true; issue: OldIssue | null } | Extract<ShareSend, { reason: string }>> {
    if (share.number) {
      const got = await po.github('GET', `/repos/${po.repo}/issues/${share.number}`, token)
      if (got.ok) {
        const old = asOldIssue(got.data, share.shareKey)
        if (old) return { ok: true, issue: old }
        po.warn(`issue #${share.number} is not this track's share (no "${TRACK_LABEL}" label or a different share key); looking for the right one`)
      } else if (got.status !== 404 && got.status !== 410) {
        return writeFailure(got)
      }
    }
    // Shared from the waiting pile, or the browser forgot the number: look for the share key.
    const list = await po.github('GET', `/repos/${po.repo}/issues?labels=${encodeURIComponent(TRACK_LABEL)}&state=all&sort=updated&direction=desc&per_page=${FIND_PAGE}`, token)
    if (!list.ok) return writeFailure(list)
    for (const item of Array.isArray(list.data) ? list.data : []) {
      const old = asOldIssue(item, share.shareKey)
      if (old) return { ok: true, issue: old }
    }
    return { ok: true, issue: null }
  }

  /** Make the "track" label once, if the repository doesn't have it yet. Never stops a share. */
  async function ensureLabel(token: string): Promise<void> {
    if (labelChecked) return
    const got = await po.github('GET', `/repos/${po.repo}/labels/${encodeURIComponent(TRACK_LABEL)}`, token)
    if (got.ok) {
      labelChecked = true
      return
    }
    if (got.status !== 404) return // offline or busy: try again next time
    const made = await po.github('POST', `/repos/${po.repo}/labels`, token, { name: TRACK_LABEL, color: LABEL_COLOUR, description: LABEL_ABOUT })
    if (made.ok || made.status === 422) {
      // 422: someone made it in the meantime.
      labelChecked = true
      po.log(`made the "${TRACK_LABEL}" label on GitHub`)
      return
    }
    labelChecked = true // asked once; GitHub may still make it when the first share uses it
    po.warn(`could not make the "${TRACK_LABEL}" label (${made.detail}); GitHub may make it with the first share`)
  }

  async function sendSaved(issue: TrackIssue, share: SavedShare, token: string): Promise<ShareSend> {
    const sent = await sendShare(issue, share, token)
    if (sent.ok) {
      listMemory = null
      if (sent.labelMissing) po.warn(`GitHub left the "${TRACK_LABEL}" label off issue #${sent.number}, so it won't show in Shared tracks`)
    }
    return sent
  }

  // ---------------------------------------------------------------- the list

  async function listShared(fresh: boolean): Promise<SharedListResult> {
    const now = Date.now()
    const ready = (await po.readToken()) !== null
    const waiting = await po.waitingCount()
    if (listMemory) {
      const age = now - listMemory.at
      const keep = listMemory.result.status === 'ok' ? (fresh ? LIST_FRESH_MIN_MS : LIST_KEEP_MS) : LIST_FAIL_KEEP_MS
      if (age < keep) return { ...listMemory.result, ready, waiting }
    }
    const result = await readList(ready, waiting)
    listMemory = { at: Date.now(), result }
    return result
  }

  async function readList(ready: boolean, waiting: number): Promise<SharedListResult> {
    const path = `/repos/${po.repo}/issues?labels=${encodeURIComponent(TRACK_LABEL)}&state=open&sort=created&direction=desc&per_page=${SHARE_LIMITS.list + 1}`
    // With the key GitHub allows far more reads an hour; without one it is a plain public read.
    const token = await po.readToken()
    let got = await po.github('GET', path, token)
    if (!got.ok && token && got.status === 401) {
      po.warn('GitHub turned the key down; reading the shared tracks without it')
      got = await po.github('GET', path, null)
    }
    if (!got.ok) {
      po.warn(`could not read the shared tracks: ${got.detail}`)
      return { status: 'unavailable', reason: got.reason, message: listWords(got, token !== null), ready, waiting }
    }
    const items: SharedTrackItem[] = []
    const all = Array.isArray(got.data) ? got.data : []
    for (const raw of all.slice(0, SHARE_LIMITS.list)) {
      const item = asListItem(raw)
      if (item) items.push(item)
    }
    return { status: 'ok', items, more: all.length > SHARE_LIMITS.list, ready, waiting }
  }

  return { handle, sendSaved }
}

// ---------------------------------------------------------------- words

const TOO_BIG = "This track is too big to share: GitHub takes up to 64 thousand letters in one post, and this track's file needs more. A track with fewer road points, props or energy cores will fit."

function listWords(got: Extract<GithubResult, { ok: false }>, hadKey: boolean): string {
  if (got.reason === 'offline' && got.status >= 500) return "GitHub is having trouble right now, so the shared tracks can't be shown. Try again in a while. Your own tracks still work."
  if (got.reason === 'offline') return "Can't reach GitHub right now, so the shared tracks can't be shown. Is the internet on? Your own tracks still work."
  if (got.reason === 'busy') {
    return `GitHub says the game has looked too many times for now. Try again in a few minutes.${hadKey ? '' : ' (With reporting switched on, the game can look more often.)'}`
  }
  return `GitHub said no when the game asked for the shared tracks (${got.detail}). Ask Dad to check.`
}

/** A failed write, worded like Report a problem's, for the waiting pile. */
function writeFailure(got: Extract<GithubResult, { ok: false }>): Extract<ShareSend, { reason: string }> {
  return { ok: false, reason: got.reason === 'refused' ? 'refused' : 'offline', status: got.status, detail: got.detail }
}

// ---------------------------------------------------------------- reading GitHub's answers

interface OldIssue {
  number: number
  url: string
  state: string
}

/** Labels come back as objects ({ name }) from GitHub; plain strings are accepted too. */
function hasTrackLabel(data: unknown): boolean {
  const labels = (data as { labels?: unknown } | null)?.labels
  if (!Array.isArray(labels)) return false
  return labels.some((l) => (typeof l === 'string' ? l : (l as { name?: unknown } | null)?.name) === TRACK_LABEL)
}

/** GitHub lists pull requests as issues too; they are never tracks. */
function isTrackIssue(data: unknown): data is { number: number; html_url: string; state?: unknown; body?: unknown; title?: unknown } {
  const d = data as { number?: unknown; html_url?: unknown; pull_request?: unknown } | null
  return !!d && typeof d.number === 'number' && typeof d.html_url === 'string' && !d.pull_request && hasTrackLabel(d)
}

function asOldIssue(data: unknown, shareKey: string): OldIssue | null {
  if (!isTrackIssue(data)) return null
  if (!issueHasShareKey(typeof data.body === 'string' ? data.body : '', shareKey)) return null
  return { number: data.number, url: data.html_url, state: String(data.state ?? 'open') }
}

function asListItem(data: unknown): SharedTrackItem | null {
  if (!isTrackIssue(data)) return null // an unlabelled issue (or a pull request) never lists
  const d = data as Record<string, unknown>
  const read = readTrackIssue(typeof d.body === 'string' ? d.body : '')
  return {
    number: data.number,
    url: data.html_url,
    title: typeof d.title === 'string' ? oneLine(d.title).slice(0, 256) : '',
    createdAt: typeof d.created_at === 'string' ? d.created_at : '',
    updatedAt: typeof d.updated_at === 'string' ? d.updated_at : '',
    shareKey: read.shareKey,
    trackText: read.trackText,
    check: read.check,
    problem: read.problem,
  }
}

// ---------------------------------------------------------------- checking a share

/** The share, cleaned, or a reason it can't be sent. The Library checked the track fully before sending it. */
function checkShare(x: unknown): ShareRequest | string {
  if (!x || typeof x !== 'object') return 'it was empty'
  const o = x as Record<string, unknown>
  const t = o.track as Record<string, unknown> | null
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'there is no track in it'
  if (t.format !== TRACK_FORMAT || t.version !== TRACK_VERSION) return "it isn't a Sundown Run II track file"
  if (typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(t.id)) return 'its id is not a track id'
  if (typeof t.name !== 'string' || !oneLine(t.name)) return 'it has no name'
  const road = t.road as { points?: unknown } | null
  if (!road || typeof road !== 'object' || !Array.isArray(road.points) || road.points.length < 4) return 'it has no road'
  if (!t.environment || typeof t.environment !== 'object') return 'it has no world'
  if (typeof o.madeBy !== 'string' || oneLine(o.madeBy).length > SHARE_LIMITS.madeBy) return `the Made by name must be up to ${SHARE_LIMITS.madeBy} letters`
  if (typeof o.world !== 'string' || oneLine(o.world).length > SHARE_LIMITS.world) return 'its world name is wrong'
  if (typeof o.shareKey !== 'string' || !SHARE_KEY.test(o.shareKey)) return 'its share key is wrong'
  const issue = o.issue
  if (issue !== null && issue !== undefined && !(typeof issue === 'number' && Number.isInteger(issue) && issue > 0)) return 'its issue number is wrong'
  return {
    track: t as unknown as TrackFile,
    madeBy: oneLine(o.madeBy),
    world: oneLine(o.world),
    shareKey: o.shareKey,
    issue: typeof issue === 'number' ? issue : null,
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}
