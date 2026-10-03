// ============================================================
//  TRACK SHARING PROTOCOL - what the Library and the server say
// ------------------------------------------------------------
//  Josh can share a track he drew: the Library's Share button sends
//  it to the game's own server (server/trackShare.ts), which posts it
//  on GitHub as an issue labelled "track", through the same post
//  office and key as Report a problem. The Library's Shared tracks
//  list reads those issues back, and Download imports one like a
//  track file.
//
//  Both sides import this file, so the shapes, the limits and the
//  way a track is written into an issue (and read back out) can never
//  drift apart. Plain data and pure functions: no browser or server
//  code in here.
//
//  An issue looks like this (the top is for people, the fenced block
//  is the track file the game reads back):
//
//    ## Canyon Run
//    **Made by:** JJ
//    **Length:** 3.2 km ... **World:** ... **Pieces:** ...
//    > what the track is about
//    <!-- sundown-run-track share=k3x9... id=canyon-run check=1f2e... -->
//    ```json
//    { "format": "sundown-run-track", ... }
//    ```
//
//  `check` is the track file's fingerprint (see fingerprint below):
//  if anyone edits the file inside the issue on GitHub, or GitHub
//  cuts a long one off, the fingerprint no longer matches and the game
//  refuses to download it.
// ============================================================

import type { Piece, TrackFile } from '../../track/schema'
import { scrubPrivate } from '../../ui/report/protocol'

/** Where the game's server listens: GET lists shared tracks, POST shares one. */
export const TRACKS_ENDPOINT = '/api/tracks'

/**
 * The GitHub label a shared track's issue carries. Only issues with it are
 * listed. GitHub only keeps labels set by someone with push access to the
 * repository (see server/trackShare.ts), so a stranger can open an issue
 * but can't make it show up in everybody's Shared tracks.
 */
export const TRACK_LABEL = 'track'

export const SHARE_LIMITS = {
  /** GitHub refuses an issue body longer than this many characters. */
  body: 65_536,
  /** A track's name and the Made by name (the same as Report a problem's name). */
  name: 40,
  madeBy: 20,
  /** The world's name, as the Library words it. */
  world: 40,
  /** The "about" line shown at the top of the issue (the file keeps all of it). */
  about: 400,
  /** The whole POST request, in bytes. A track that fits in an issue fits in this. */
  request: 256 * 1024,
  /** Shared tracks listed, newest first (GitHub gives at most 100 a page). */
  list: 50,
} as const

// ---------------------------------------------------------------- what goes back and forth

/** POST TRACKS_ENDPOINT: share one track. */
export interface ShareRequest {
  /** The track file to share, as saved in the Library. */
  track: TrackFile
  /** The public name in Made by (a nickname). Empty for none. */
  madeBy: string
  /** The world's name in words (the Library knows the base worlds; the server doesn't). */
  world: string
  /** Random letters this browser picked for this track the first time it was shared. */
  shareKey: string
  /** The issue this track was shared as before, if this browser knows it. */
  issue: number | null
}

/** Why a share waits on this computer: the same reasons as a report. */
export type ShareSavedReason = 'no-token' | 'offline' | 'refused'

/** The server's answer to a share. */
export type ShareResult =
  | {
      status: 'sent'
      number: number
      url: string
      /** True when it changed the issue this track was shared as before (no copy made). */
      updated: boolean
      /** GitHub left off the "track" label, so it won't show in Shared tracks. */
      labelMissing: boolean
    }
  | { status: 'saved'; reason: ShareSavedReason; waiting: number; detail?: string }
  | { status: 'rejected'; reason: 'too-many' | 'invalid' | 'full' | 'too-big' | 'taken-down'; message: string }

/** One shared track as the server found it on GitHub. The browser checks it before showing or downloading it. */
export interface SharedTrackItem {
  number: number
  url: string
  title: string
  /** When it was first shared and last changed (GitHub's ISO times). */
  createdAt: string
  updatedAt: string
  /** The share key from the issue (lets this browser find the issue it shared). */
  shareKey: string | null
  /** The track file's text from the fenced block, or null when there isn't a whole one. */
  trackText: string | null
  /** The fingerprint written next to it when it was shared. */
  check: string | null
  /** Why there is no whole track file in it, in plain words. */
  problem: string | null
}

/** GET TRACKS_ENDPOINT. */
export type SharedListResult =
  | {
      status: 'ok'
      items: SharedTrackItem[]
      /** More shared tracks than the list shows. */
      more: boolean
      /** A GitHub key is set up on this computer (Share goes straight up). */
      ready: boolean
      /** Reports and shares saved here, waiting to send. */
      waiting: number
    }
  | {
      status: 'unavailable'
      /** offline: no internet or GitHub down; busy: GitHub's rate limit; refused: GitHub said no. */
      reason: 'offline' | 'busy' | 'refused'
      message: string
      ready: boolean
      waiting: number
    }

// ---------------------------------------------------------------- the fingerprint

/**
 * The same track file always gives the same text here, however it was
 * spaced out: GitHub may change line endings when an issue is edited on the
 * website, and that must not count as a change. Any changed value does.
 */
export function canonicalTrackText(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * A fingerprint of a track file: 26 letters and digits that change if any
 * value in the file changes. It catches a file edited on GitHub or cut off;
 * it is not a lock (anyone who can edit the issue could write a new one), so
 * a downloaded track is always fully checked by the game's validator too.
 *
 * Two runs of cyrb53 (a small, well-known string hash) with different seeds.
 * Plain maths on purpose: the browser's crypto.subtle only works on secure
 * pages, and LAN players load the game over plain http.
 */
export function fingerprint(canonical: string): string {
  return cyrb53(canonical, 0x5d2a).toString(16).padStart(14, '0') + cyrb53(canonical, 0x2b71).toString(16).padStart(14, '0')
}

function cyrb53(s: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

// ---------------------------------------------------------------- small words about a track

/** Rough road length in metres from the control points (the same curve TrackThumb draws). */
export function roadLengthM(file: Pick<TrackFile, 'road'>): number {
  const pts = file.road?.points
  if (!Array.isArray(pts) || pts.length < 3) return 0
  const n = pts.length
  const at = (i: number) => pts[((i % n) + n) % n]
  let total = 0
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    let px = p1.x
    let pz = p1.z
    for (let k = 1; k <= 8; k++) {
      const t = k / 8
      const t2 = t * t
      const t3 = t2 * t
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      const x = cr(p0.x, p1.x, p2.x, p3.x)
      const z = cr(p0.z, p1.z, p2.z, p3.z)
      total += Math.hypot(x - px, z - pz)
      px = x
      pz = z
    }
  }
  return Number.isFinite(total) ? total : 0
}

/** "3.2 km" or "850 m". */
export function lengthWords(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

const PIECE_WORDS: Record<Piece['type'], [string, string]> = {
  boost: ['boost pad', 'boost pads'],
  ramp: ['ramp', 'ramps'],
  loop: ['loop', 'loops'],
  wallride: ['wall ride', 'wall rides'],
  speedtrap: ['speed trap', 'speed traps'],
  tunnel: ['tunnel', 'tunnels'],
}

/** "2 loops, 3 boost pads" or "none". */
export function pieceWords(file: Pick<TrackFile, 'pieces'>): string {
  const counts = new Map<Piece['type'], number>()
  for (const p of Array.isArray(file.pieces) ? file.pieces : []) {
    const type = (p as { type?: unknown } | null)?.type
    if (typeof type === 'string' && type in PIECE_WORDS) counts.set(type as Piece['type'], (counts.get(type as Piece['type']) ?? 0) + 1)
  }
  if (!counts.size) return 'none'
  return [...counts].map(([type, n]) => `${n} ${PIECE_WORDS[type][n === 1 ? 0 : 1]}`).join(', ')
}

// ---------------------------------------------------------------- cleaning text

/** A trimmed single line: no control characters, runs of spaces squashed. */
export function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Stop "@someone" from pinging a stranger on GitHub (a zero-width space after the @). */
function noMentions(s: string): string {
  return s.replace(/@(?=[A-Za-z0-9_-])/g, '@​')
}

/** Text for the readable top: no links, pictures or headings sneaked in through a track's name. */
function plainMarkdown(s: string): string {
  return noMentions(s).replace(/[\\`*_{}[\]()<>#!|~]/g, (c) => `\\${c}`)
}

/** Cut to `max` letters, with "..." when it was longer. */
function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s
}

/** The Made by name as it goes public: one line, short, no folder paths. Empty for none. */
export function cleanMadeBy(s: string): string {
  return cut(oneLine(scrubPrivate(s)), SHARE_LIMITS.madeBy)
}

/**
 * The track file exactly as it goes public: Made by in `author`, and no
 * computer user names hiding in the name or the about text.
 */
export function publicTrackFile(file: TrackFile, madeBy: string): TrackFile {
  const out: TrackFile = { ...file, name: cut(oneLine(scrubPrivate(file.name)), SHARE_LIMITS.name) || 'My Track' }
  const by = cleanMadeBy(madeBy)
  if (by) out.author = by
  else delete out.author
  if (typeof file.description === 'string') {
    const about = scrubPrivate(file.description).trim()
    if (about) out.description = about
    else delete out.description
  }
  return out
}

// ---------------------------------------------------------------- writing the issue

/** The issue as GitHub's create and edit calls want it. */
export interface TrackIssue {
  title: string
  body: string
  labels: string[]
}

/** Every shared track's issue also gets Report a problem's label, so Dad sees everything from the game in one place. */
export const LABEL_GAME = 'from the game'

const MARKER = 'sundown-run-track'

/**
 * Write a shared track as an issue. `file` must already be the public file
 * (publicTrackFile). The track goes in pretty-printed when it fits, else on
 * one line; returns null when even that is over GitHub's limit.
 */
export function buildTrackIssue(file: TrackFile, world: string, shareKey: string): TrackIssue | null {
  const by = file.author ?? ''
  const title = `Track: ${file.name}${by ? ` by ${by}` : ''}`
  const top: string[] = [
    `## ${plainMarkdown(file.name)}`,
    '',
    `**Made by:** ${by ? plainMarkdown(by) : '(no name given)'}  `,
    `**Length:** ${lengthWords(roadLengthM(file))}  `,
    `**World:** ${plainMarkdown(cut(oneLine(world), SHARE_LIMITS.world)) || 'unknown'}  `,
    `**Pieces:** ${pieceWords(file)}`,
  ]
  if (file.description) {
    top.push('')
    for (const line of cut(file.description.replace(/\r\n?/g, '\n'), SHARE_LIMITS.about).split('\n')) top.push(`> ${plainMarkdown(oneLine(line))}`)
  }
  top.push('', '**To drive it:** open the road editor in Sundown Run II, press Library, then Shared tracks, and press Download next to it.', '')
  const canonical = JSON.stringify(file)
  const marker = `<!-- ${MARKER} share=${shareKey} id=${safeId(file.id)} check=${fingerprint(canonical)} -->`
  const foot = ['', '_Shared from the road editor in Sundown Run II. To take this track down, close this issue._']
  for (const text of [JSON.stringify(file, null, 2), canonical]) {
    // A fence longer than any run of ` inside the file, so a name with ``` in it can't end the block early.
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const body = [...top, marker, `${fence}json`, text, fence, ...foot].join('\n')
    if (body.length <= SHARE_LIMITS.body) return { title: cut(oneLine(noMentions(title)), 250), body, labels: [TRACK_LABEL, LABEL_GAME] }
  }
  return null
}

/** How big a track's issue is, in characters, or null when it is too big for GitHub. */
export function issueSize(file: TrackFile, world: string): number | null {
  return buildTrackIssue(file, world, 'x'.repeat(12))?.body.length ?? null
}

function safeId(id: string): string {
  return String(id).replace(/[^a-z0-9-]/g, '').slice(0, 64) || 'track'
}

// ---------------------------------------------------------------- reading the issue back

/** What a shared track's issue holds: the file's text and its fingerprint, or why there isn't a whole one. */
export interface ReadIssue {
  shareKey: string | null
  check: string | null
  trackText: string | null
  problem: string | null
}

/** Find the track file inside an issue's text. Never throws. */
export function readTrackIssue(body: string | null | undefined): ReadIssue {
  const text = typeof body === 'string' ? body.replace(/\r\n?/g, '\n') : ''
  const m = /<!--\s*sundown-run-track\s+([^>]*?)\s*-->/.exec(text)
  if (!m) return { shareKey: null, check: null, trackText: null, problem: "there's no track file in it" }
  const field = (name: string) => new RegExp(`(?:^|\\s)${name}=([A-Za-z0-9-]+)`).exec(m[1])?.[1] ?? null
  const shareKey = field('share')
  const check = field('check')
  const after = text.slice(m.index + m[0].length)
  const open = /^\s*\n(`{3,})json[^\n]*\n/.exec(after)
  if (!open) return { shareKey, check, trackText: null, problem: "there's no track file in it" }
  const rest = after.slice(open[0].length)
  const close = new RegExp(`(^|\\n)${open[1]}[ \\t]*(\\n|$)`).exec(rest)
  if (!close) return { shareKey, check, trackText: null, problem: 'its track file is cut off' }
  return { shareKey, check, trackText: rest.slice(0, close.index), problem: null }
}

/** Does this issue's text hold a track shared with this share key? */
export function issueHasShareKey(body: string | null | undefined, shareKey: string): boolean {
  return readTrackIssue(body).shareKey === shareKey
}

/**
 * Is the track file inside a shared track's issue whole, and unchanged since
 * it was shared? Returns the file's text in the one fixed spacing, or why not
 * in plain words. (The browser then runs the game's validator on it too.)
 */
export function verifySharedTrack(item: Pick<SharedTrackItem, 'trackText' | 'check' | 'problem'>): { ok: true; canonical: string } | { ok: false; why: string } {
  if (item.problem || item.trackText === null) return { ok: false, why: `It can't be downloaded: ${item.problem ?? "there's no track file in it"}.` }
  const canonical = canonicalTrackText(item.trackText)
  if (canonical === null) return { ok: false, why: "It can't be downloaded: its track file is cut off or broken." }
  if (!item.check || fingerprint(canonical) !== item.check) {
    return { ok: false, why: "It can't be downloaded: its track file was changed on GitHub after it was shared, so the game doesn't trust it." }
  }
  return { ok: true, canonical }
}

/** A share key: 16 random lowercase letters and digits. */
export const SHARE_KEY = /^[a-z0-9]{8,32}$/
