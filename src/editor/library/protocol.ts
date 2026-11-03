// ============================================================
//  ONLINE TRACK LIBRARY PROTOCOL - what the game and the Worker say
// ------------------------------------------------------------
//  Online (the https copy on Cloudflare) every track you draw saves
//  itself to the track library under your login, and the Library's
//  Everyone's tracks lists every player's tracks. The Worker side is
//  cloud/worker.ts + cloud/library.ts; the browser side is sync.ts.
//
//  Both sides import this file, so the shapes, the limits and the id
//  rules can never drift apart. Plain data and pure functions only:
//  no browser or Cloudflare code in here.
//
//    GET    /api/library                every track: whose, name, when, size
//    GET    /api/library/tracks/<id>    one track, with its file
//    POST   /api/library/tracks         save a new track (the server picks its id)
//    PUT    /api/library/tracks/<id>    save a new version of one of YOUR tracks
//    DELETE /api/library/tracks/<id>    delete one of YOUR tracks
//    POST   /api/library/admin/import   (admins) put a track in someone's library
//
//  Who you are is your Cloudflare Access login, checked by the Worker.
//  Nobody else ever sees your email: lists show your player name.
// ============================================================

import type { TrackFile } from '../../track/schema'

export const LIBRARY_ENDPOINT = '/api/library'

export const LIBRARY_LIMITS = {
  /** Tracks one player may keep online. */
  tracksPerPlayer: 100,
  /** One track file, in bytes as stored. A big hand-drawn track is about 40 KB. */
  trackBytes: 128 * 1024,
  /** All of one player's tracks together, in bytes. */
  playerBytes: 4 * 1024 * 1024,
  /** A whole save request, in bytes (a track plus a little). */
  request: 160 * 1024,
  /** A track id's length. */
  idLength: 64,
} as const

/** A library track id: lower-case letters, digits and single dashes, like the file names in tracks/. */
export const TRACK_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/**
 * Ids the library never hands out: the built-in tracks in tracks/ (a
 * check in cloud/library.test.ts keeps this list matching the folder).
 */
export const BUILTIN_TRACK_IDS: readonly string[] = ['afterglow', 'ember-pass', 'hyperdrome', 'neon-pocket', 'thunder-bowl']

/** A track id made from a name ("Canyon Run!" -> canyon-run), or '' if nothing is left. */
export function slugId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIBRARY_LIMITS.idLength - 6)
    .replace(/-+$/g, '')
}

/** A player name as the game shows it on name tags (the same rule as ?name=): 14 letters, capitals. */
export function cleanPlayerName(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N} _.'-]/gu, '')
    .trim()
    .slice(0, 14)
    .toUpperCase()
}

/** Bytes a text takes as UTF-8 (what the limits count). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

// ---------------------------------------------------------------- what goes back and forth

/** One track in the library, without its file. */
export interface LibraryTrackMeta {
  id: string
  name: string
  /** The owner's player name (never their email). */
  ownerName: string
  /** True when it is one of yours. */
  mine: boolean
  /** Goes up by one every time the owner saves a new version. */
  rev: number
  /** When it was last saved (ms since 1970, the server's clock). */
  updated: number
  /** Bytes, as stored. */
  size: number
}

/** Why the library said no, in words to show. */
export type LibraryRefusalCode =
  /** The library isn't switched on (ACCESS_AUD not set). */
  | 'off'
  /** No valid login came with the request. */
  | 'no-login'
  /** Someone else's track: you can't change or delete it. */
  | 'not-yours'
  | 'not-found'
  /** Too many tracks, or too many bytes all together, or one track too big. */
  | 'too-many'
  | 'full'
  | 'too-big'
  /** Not a track the game can load, or a request the library can't read. */
  | 'invalid'
  /** It was saved from another computer since this one last looked (current rev attached). */
  | 'changed'
  /** Only for admins. */
  | 'not-admin'
  | 'error'

export interface LibraryRefusal {
  status: 'refused'
  code: LibraryRefusalCode
  message: string
  /** With 'changed': the version the library has now. */
  rev?: number
}

export interface LibraryMe {
  /** Your player name as the library shows it (null until your first save). */
  name: string | null
  /** An opaque tag for your login (a hash, never the email), so a browser can tell two logins apart. */
  key: string
}

export type LibraryListResult = { status: 'ok'; me: LibraryMe; tracks: LibraryTrackMeta[] } | LibraryRefusal

export type LibraryGetResult = { status: 'ok'; track: LibraryTrackMeta & { file: string } } | LibraryRefusal

/** POST (new) or PUT (new version of one of yours). */
export interface LibrarySaveRequest {
  file: TrackFile
  /** Your player name, shown as the owner in everyone's lists. */
  playerName: string
  /** PUT only: the version this computer last had. A different one online is 'changed'. */
  baseRev?: number
}

export type LibrarySaveResult =
  | {
      status: 'ok'
      id: string
      rev: number
      updated: number
      size: number
      /** The id the track was sent with, when the library had to give it a different one (it was taken). */
      movedFrom: string | null
    }
  | LibraryRefusal

export type LibraryDeleteResult = { status: 'ok'; id: string } | LibraryRefusal

/** POST /api/library/admin/import: put a track in a player's library (the one-time GitHub import). */
export interface LibraryImportRequest {
  /** The owner's login email (as Cloudflare Access sees it). */
  owner: string
  /** The owner's player name for the lists. */
  ownerName: string
  file: TrackFile
}
