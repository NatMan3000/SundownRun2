// ============================================================
//  TRACK SHARING, THE BROWSER SIDE - talk to the server, check tracks
// ------------------------------------------------------------
//  The Library's Share box and Shared tracks list (ShareUi.tsx) use
//  this file. The browser never talks to GitHub itself (the key must
//  stay on the server): it asks the game's own server at /api/tracks
//  (server/trackShare.ts), which posts and reads the issues.
//
//  What this browser remembers (localStorage):
//    sr2.share.mine.v1        each track it shared: its share key and
//                             issue number, so sharing again edits the
//                             same post instead of making a copy
//    sr2.share.madeBy.v1      the last Made by name, for next time
//    sr2.share.downloaded.v1  each track downloaded from Shared tracks:
//                             who made it and which post it came from
//
//  Every shared track is checked here before it is shown as ready or
//  downloaded: its fingerprint must match (nobody changed it on GitHub,
//  and it isn't cut off), and the game's validator must pass it.
//
//  For checkers: __dev.share('help') (see the bottom of this file).
// ============================================================

import { registerDev } from '../../core/devHandles'
import type { TrackFile } from '../../track/schema'
import { getTrackFile, listDrawnTracks } from '../../track/registry'
import { validateTrack } from '../../track/validate'
import { BASE_WORLDS } from '../draftFile'
import { type ImportResult, importTrackText } from '../importTrack'
import {
  SHARE_LIMITS,
  TRACKS_ENDPOINT,
  cleanMadeBy,
  fingerprint,
  issueSize,
  lengthWords,
  pieceWords,
  publicTrackFile,
  roadLengthM,
  type ShareRequest,
  type ShareResult,
  type SharedListResult,
  type SharedTrackItem,
  verifySharedTrack,
} from './protocol'

const MINE_KEY = 'sr2.share.mine.v1'
const MADE_BY_KEY = 'sr2.share.madeBy.v1'
const DOWNLOADED_KEY = 'sr2.share.downloaded.v1'
/** The server waits up to 15 s for GitHub (twice when it edits a post), so give it longer than that. */
const SHARE_TIMEOUT_MS = 45_000
const LIST_TIMEOUT_MS = 25_000

// ---------------------------------------------------------------- remembering

interface MyShare {
  shareKey: string
  issue: number | null
  /** The fingerprint of what was shared last. */
  check: string
}

interface Downloaded {
  issue: number
  madeBy: string
  check: string
}

function readJson<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key)
    const v: unknown = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {}
  } catch (err) {
    console.error(`[share] could not read ${key} from this browser`, err)
    return {}
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.error(`[share] could not save ${key} in this browser (storage full?)`, err)
  }
}

/** What this browser remembers about sharing a track (null if it never shared it). */
export function myShare(trackId: string): MyShare | null {
  return readJson<MyShare>(MINE_KEY)[trackId] ?? null
}

function rememberShare(trackId: string, share: MyShare): void {
  const all = readJson<MyShare>(MINE_KEY)
  all[trackId] = share
  writeJson(MINE_KEY, all)
}

/** The share key for a track: the remembered one, or new random letters. */
function shareKeyFor(trackId: string): string {
  const known = myShare(trackId)?.shareKey
  if (known) return known
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => letters[b % letters.length]).join('')
}

/**
 * The Made by name to offer: the last one used, else the track's author. Never
 * the author of a track downloaded from Shared tracks: that is somebody else's
 * name, and your changed version shouldn't go up as theirs.
 */
export function madeByFor(file: TrackFile): string {
  try {
    const last = localStorage.getItem(MADE_BY_KEY)
    if (last) return cleanMadeBy(last)
  } catch (err) {
    console.error('[share] could not read the last Made by name', err)
  }
  return downloadedFrom(file.id) ? '' : cleanMadeBy(file.author ?? '')
}

function rememberMadeBy(name: string): void {
  try {
    localStorage.setItem(MADE_BY_KEY, name)
  } catch (err) {
    console.error('[share] could not save the Made by name', err)
  }
}

/** Where a track in your Library came from, if it was downloaded from Shared tracks. */
export function downloadedFrom(trackId: string): Downloaded | null {
  return readJson<Downloaded>(DOWNLOADED_KEY)[trackId] ?? null
}

// ---------------------------------------------------------------- words about a track

/** The world a track is set in, in words: a base world's name when it is one, else what it is like. */
export function worldName(file: TrackFile): string {
  const env = file.environment
  const t = env?.terrain
  const base = BASE_WORLDS.find((b) => {
    const bt = b.environment.terrain
    return bt.kind === t?.kind && bt.relief === t?.relief && bt.scale === t?.scale && b.environment.sky?.timeOfDay === env?.sky?.timeOfDay
  })
  if (base) return base.name
  const night = (env?.sky?.timeOfDay ?? 0) >= 0.5
  if (env?.stadium) return night ? 'Stadium at night' : 'Stadium'
  return `${t?.kind === 'flat' ? 'Flat' : 'Hills'} at ${night ? 'night' : 'sundown'}`
}

/** "3.2 km, Neon Valley, 2 loops" for a list row. */
export function trackFacts(file: TrackFile): { length: string; world: string; pieces: string } {
  return { length: lengthWords(roadLengthM(file)), world: worldName(file), pieces: pieceWords(file) }
}

// ---------------------------------------------------------------- can it be shared?

export type Shareable = { ok: true; size: number; again: number | null; changedSince: boolean } | { ok: false; why: string }

/** Can this track be shared, and if not, why not (shown on hover before any click). */
export function canShare(file: TrackFile, madeBy = madeByFor(file)): Shareable {
  const from = downloadedFrom(file.id)
  if (from && fingerprint(JSON.stringify(file)) === from.check) {
    return { ok: false, why: `This is ${from.madeBy || 'somebody'}'s track from Shared tracks. Change something first, then you can share your own version.` }
  }
  if (!Array.isArray(file.road?.points) || file.road.points.length < 4) return { ok: false, why: 'There is no road to share yet.' }
  const size = issueSize(publicTrackFile(file, madeBy), worldName(file))
  if (size === null) {
    return { ok: false, why: "It's too big to share: GitHub takes up to 64 thousand letters in one post. A track with fewer road points, props or energy cores will fit." }
  }
  const mine = myShare(file.id)
  const changedSince = !!mine && mine.check !== fingerprint(JSON.stringify(publicTrackFile(file, madeBy)))
  return { ok: true, size, again: mine ? mine.issue ?? 0 : null, changedSince }
}

// ---------------------------------------------------------------- talking to the server

function isShareResult(x: unknown): x is ShareResult {
  const s = (x as { status?: unknown } | null)?.status
  return s === 'sent' || s === 'saved' || s === 'rejected'
}

/**
 * Share a track. Always resolves: sent, saved on this computer (no key, no
 * internet), or rejected with words to show.
 */
export async function shareTrack(file: TrackFile, madeBy: string): Promise<ShareResult> {
  const by = cleanMadeBy(madeBy)
  rememberMadeBy(by)
  const shareKey = shareKeyFor(file.id)
  const request: ShareRequest = { track: file, madeBy: by, world: worldName(file), shareKey, issue: myShare(file.id)?.issue ?? null }
  let res: Response
  try {
    res = await fetch(TRACKS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
    })
  } catch (err) {
    console.warn('[share] the game server did not answer', err)
    return { status: 'rejected', reason: 'invalid', message: NO_SERVER }
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch (err) {
    console.warn(`[share] the game server answered ${res.status} with something that isn't JSON`, err)
  }
  if (!isShareResult(body)) return { status: 'rejected', reason: 'invalid', message: NO_SERVER }
  const check = fingerprint(JSON.stringify(publicTrackFile(file, by)))
  if (body.status === 'sent') rememberShare(file.id, { shareKey, issue: body.number || null, check })
  // Saved to send later: remember the key now, so the server finds the post it makes and edits that one next time.
  else if (body.status === 'saved') rememberShare(file.id, { shareKey, issue: myShare(file.id)?.issue ?? null, check })
  return body
}

const NO_SERVER = "The game's server isn't answering, so the track couldn't be shared. Start the game again and share it then."

/** The open shared tracks, newest first, or 'no-server' when the game's server can't be reached. */
export async function fetchSharedList(fresh = false): Promise<SharedListResult | 'no-server'> {
  try {
    const res = await fetch(`${TRACKS_ENDPOINT}${fresh ? '?fresh=1' : ''}`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
    const body = (await res.json()) as SharedListResult
    if (body?.status === 'ok' && Array.isArray(body.items)) {
      learnIssueNumbers(body.items)
      return body
    }
    if (body?.status === 'unavailable' && typeof body.message === 'string') return body
    console.warn(`[share] the game server answered ${res.status} with something unexpected about shared tracks`)
    return 'no-server'
  } catch (err) {
    console.warn('[share] could not ask the game server for the shared tracks', err)
    return 'no-server'
  }
}

/** A share that went from the waiting pile: find its post by share key and remember the number. */
function learnIssueNumbers(items: SharedTrackItem[]): void {
  const mine = readJson<MyShare>(MINE_KEY)
  let changed = false
  for (const m of Object.values(mine)) {
    if (m.issue) continue
    const found = items.find((i) => i.shareKey === m.shareKey)
    if (found) {
      m.issue = found.number
      changed = true
    }
  }
  if (changed) writeJson(MINE_KEY, mine)
}

// ---------------------------------------------------------------- checking and downloading

export type CheckedItem =
  | { ok: true; item: SharedTrackItem; file: TrackFile; madeBy: string; facts: ReturnType<typeof trackFacts>; mine: boolean; have: string | null }
  | { ok: false; item: SharedTrackItem; why: string; mine: boolean }

/** Check one shared track before showing it as ready: whole, unchanged since it was shared, and a track the game can load. */
export function checkSharedItem(item: SharedTrackItem): CheckedItem {
  const mine = Object.values(readJson<MyShare>(MINE_KEY)).some((m) => m.shareKey === item.shareKey && !!item.shareKey)
  const whole = verifySharedTrack(item)
  if (!whole.ok) return { ok: false, item, mine, why: whole.why }
  const parsed = JSON.parse(whole.canonical) as unknown
  const result = validateTrack(parsed)
  if (!result.ok) return { ok: false, item, mine, why: `It can't be downloaded: it isn't a track this game can load (${result.errors[0]?.message ?? 'something in it is wrong'}).` }
  const file = parsed as TrackFile
  const have = Object.entries(readJson<Downloaded>(DOWNLOADED_KEY)).find(([id, d]) => d.issue === item.number && d.check === item.check && getTrackFile(id))?.[0] ?? null
  return { ok: true, item, file, madeBy: cleanMadeBy(file.author ?? ''), facts: trackFacts(file), mine, have }
}

/**
 * Download a shared track into your Library, through the same path as
 * Import a track file: checked again, never overwriting, and marked as
 * shared by its Made by name.
 */
export function downloadShared(item: SharedTrackItem): ImportResult {
  const checked = checkSharedItem(item)
  if (!checked.ok) return { ok: false, why: checked.why }
  const result = importTrackText(item.trackText as string)
  if (!result.ok) return result
  const all = readJson<Downloaded>(DOWNLOADED_KEY)
  const saved = listDrawnTracks().find((t) => t.id === result.id)
  // The fingerprint of the file as saved here (renaming it changes it), so Share knows an untouched download.
  all[result.id] = { issue: item.number, madeBy: checked.madeBy, check: saved ? fingerprint(JSON.stringify(saved)) : (item.check as string) }
  writeJson(DOWNLOADED_KEY, all)
  return result
}

// ---------------------------------------------------------------- for checkers

let lastList: SharedListResult | 'no-server' | null = null

async function shareCommand(cmd = 'help', arg?: unknown, arg2?: unknown): Promise<unknown> {
  switch (cmd) {
    case 'list': {
      lastList = await fetchSharedList(arg === 'fresh')
      if (lastList === 'no-server' || lastList.status !== 'ok') return lastList
      return {
        ...lastList,
        items: lastList.items.map((item) => {
          const c = checkSharedItem(item)
          return c.ok ? { number: item.number, ok: true, name: c.file.name, madeBy: c.madeBy, ...c.facts, mine: c.mine, have: c.have } : { number: item.number, ok: false, title: item.title, why: c.why }
        }),
      }
    }
    case 'download': {
      if (!lastList || lastList === 'no-server' || lastList.status !== 'ok') return { ok: false, why: "run __dev.share('list') first" }
      const item = lastList.items.find((i) => i.number === Number(arg))
      return item ? downloadShared(item) : { ok: false, why: `no shared track #${String(arg)} in the last list` }
    }
    case 'can': {
      const file = getTrackFile(String(arg))
      return file ? canShare(file, typeof arg2 === 'string' ? arg2 : undefined) : { ok: false, why: `no track ${String(arg)}` }
    }
    case 'share': {
      const file = listDrawnTracks().find((t) => t.id === String(arg))
      if (!file) return { status: 'rejected', message: `no track ${String(arg)} in your Library` }
      return shareTrack(file, typeof arg2 === 'string' ? arg2 : madeByFor(file))
    }
    case 'mine':
      return { mine: readJson<MyShare>(MINE_KEY), downloaded: readJson<Downloaded>(DOWNLOADED_KEY), madeBy: localStorage.getItem(MADE_BY_KEY) }
    default:
      return {
        commands: {
          "list [, 'fresh']": 'the Shared tracks list, each checked (ok, or why it is refused)',
          'download, n': "Download shared track #n from the last list (the same as the button)",
          'can, id [, madeBy]': 'can this track be shared, and why not',
          'share, id [, madeBy]': 'share one of your tracks (the same as the Share box)',
          mine: "what this browser remembers: tracks it shared, tracks it downloaded, the Made by name",
        },
        limits: SHARE_LIMITS,
      }
  }
}

registerDev('share', shareCommand as (...args: never[]) => unknown, "track sharing: __dev.share('help')")
