// ============================================================
//  LIBRARY STORE - the online track library's rules and tables
// ------------------------------------------------------------
//  Everything the library decides lives here, on a plain SQL
//  connection: cloud/library.ts hands it the Durable Object's own
//  SQLite database, and cloud/library.test.ts hands it bun:sqlite.
//  No Cloudflare imports.
//
//  Two tables:
//    players  owner key -> the player name shown in lists
//    tracks   one row per track: id (unique across everyone), owner,
//             name, the file's text, its size, version and times
//
//  The rules:
//    - a track id is unique across every player. A new track keeps
//      the id it was drawn with when nobody has it; otherwise the
//      library gives it a fresh one (canyon-run-k3x9) and says so,
//      so two players' tracks can never share an id;
//    - only the owner can save a new version or delete a track;
//    - a new version must say which version it was made from, so a
//      track changed on two computers is never silently overwritten;
//    - caps per player: how many tracks, how big each, how big all.
//
//  The owner key is a hash of the login email (the Worker makes it),
//  so the database holds no email addresses.
// ============================================================

import type { TrackFile } from '../src/track/schema'
import {
  BUILTIN_TRACK_IDS,
  LIBRARY_LIMITS,
  TRACK_ID_RE,
  type LibraryDeleteResult,
  type LibraryGetResult,
  type LibraryMe,
  type LibraryRefusal,
  type LibraryRefusalCode,
  type LibrarySaveResult,
  type LibraryTrackMeta,
  cleanPlayerName,
  slugId,
  utf8Bytes,
} from '../src/editor/library/protocol'

/** The bit of a SQL connection the store needs (the Durable Object's ctx.storage.sql has this shape). */
export interface Sql {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] }
}

export interface StoreDeps {
  sql: Sql
  /** Run fn as one transaction: all of it lands, or none of it. */
  transaction<T>(fn: () => T): T
  now?: () => number
  /** Four random letters and digits for a fresh id. */
  randomSuffix?: () => string
}

interface TrackRow extends Record<string, unknown> {
  id: string
  owner: string
  name: string
  owner_name: string | null
  rev: number
  updated: number
  size: number
}

export function refuse(code: LibraryRefusalCode, message: string, extra: Partial<LibraryRefusal> = {}): LibraryRefusal {
  return { status: 'refused', code, message, ...extra }
}

function defaultSuffix(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => letters[b % letters.length]).join('')
}

export class LibraryStore {
  private readonly sql: Sql
  private readonly tx: <T>(fn: () => T) => T
  private readonly now: () => number
  private readonly suffix: () => string

  constructor(deps: StoreDeps) {
    this.sql = deps.sql
    this.tx = deps.transaction
    this.now = deps.now ?? Date.now
    this.suffix = deps.randomSuffix ?? defaultSuffix
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (owner TEXT PRIMARY KEY, name TEXT NOT NULL, seen INTEGER NOT NULL)`)
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL, rev INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
    )
    this.sql.exec(`CREATE INDEX IF NOT EXISTS tracks_by_owner ON tracks (owner)`)
  }

  private meta(row: TrackRow, owner: string): LibraryTrackMeta {
    return { id: row.id, name: row.name, ownerName: row.owner_name || 'SOMEONE', mine: row.owner === owner, rev: row.rev, updated: row.updated, size: row.size }
  }

  private row(id: string): TrackRow | null {
    return (
      this.sql
        .exec<TrackRow>(`SELECT t.id, t.owner, t.name, p.name AS owner_name, t.rev, t.updated, t.size FROM tracks t LEFT JOIN players p ON p.owner = t.owner WHERE t.id = ?`, id)
        .toArray()[0] ?? null
    )
  }

  /** Every track, newest first, without files. */
  list(owner: string): { me: LibraryMe; tracks: LibraryTrackMeta[] } {
    const rows = this.sql
      .exec<TrackRow>(`SELECT t.id, t.owner, t.name, p.name AS owner_name, t.rev, t.updated, t.size FROM tracks t LEFT JOIN players p ON p.owner = t.owner ORDER BY t.updated DESC`)
      .toArray()
    const me = this.sql.exec<{ name: string }>(`SELECT name FROM players WHERE owner = ?`, owner).toArray()[0]
    return { me: { name: me?.name ?? null, key: owner }, tracks: rows.map((r) => this.meta(r, owner)) }
  }

  get(owner: string, id: string): LibraryGetResult {
    const row = this.row(id)
    if (!row) return refuse('not-found', "That track isn't in the library any more.")
    const file = this.sql.exec<{ file: string }>(`SELECT file FROM tracks WHERE id = ?`, id).toArray()[0]?.file ?? ''
    return { status: 'ok', track: { ...this.meta(row, owner), file } }
  }

  /** An id nobody has: the one asked for if it is free and allowed, else one made from it or the name. */
  private freeId(wanted: string, name: string): string {
    const ok = (id: string) => TRACK_ID_RE.test(id) && !BUILTIN_TRACK_IDS.includes(id) && !this.row(id)
    if (ok(wanted)) return wanted
    const base = (TRACK_ID_RE.test(wanted) ? wanted.slice(0, LIBRARY_LIMITS.idLength - 6).replace(/-+$/, '') : '') || slugId(name) || 'track'
    for (let i = 0; i < 50; i++) {
      const id = `${base}-${this.suffix()}`
      if (ok(id)) return id
    }
    throw new Error('could not find a free track id in 50 tries')
  }

  private remember(owner: string, playerName: string): void {
    const name = cleanPlayerName(playerName) || 'RACER'
    this.sql.exec(`INSERT INTO players (owner, name, seen) VALUES (?, ?, ?) ON CONFLICT (owner) DO UPDATE SET name = excluded.name, seen = excluded.seen`, owner, name, this.now())
  }

  private totals(owner: string): { count: number; bytes: number } {
    const t = this.sql.exec<{ count: number; bytes: number | null }>(`SELECT COUNT(*) AS count, SUM(size) AS bytes FROM tracks WHERE owner = ?`, owner).toArray()[0]
    return { count: Number(t?.count ?? 0), bytes: Number(t?.bytes ?? 0) }
  }

  /**
   * Save a new track (already checked by the game's validator). It keeps its
   * id when nobody has it; otherwise it gets a fresh one (movedFrom says so).
   */
  create(owner: string, playerName: string, file: TrackFile): LibrarySaveResult {
    return this.tx(() => {
      const { count, bytes } = this.totals(owner)
      if (count >= LIBRARY_LIMITS.tracksPerPlayer) return refuse('too-many', `You have ${count} tracks online, the most you can keep. Delete one you don't race any more, then this one saves.`)
      const wanted = String(file.id ?? '')
      const id = this.freeId(wanted, file.name)
      const stored: TrackFile = { ...file, id }
      // Keep the file's own key order (id stays where it was), so every computer builds the identical file.
      const text = JSON.stringify(id === wanted ? file : stored)
      const size = utf8Bytes(text)
      if (size > LIBRARY_LIMITS.trackBytes) return refuse('too-big', tooBig(size))
      if (bytes + size > LIBRARY_LIMITS.playerBytes) return refuse('full', FULL)
      const now = this.now()
      this.remember(owner, playerName)
      this.sql.exec(`INSERT INTO tracks (id, owner, name, file, size, rev, created, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, id, owner, file.name, text, size, now, now)
      return { status: 'ok', id, rev: 1, updated: now, size, movedFrom: id === wanted ? null : wanted }
    })
  }

  /** Save a new version of one of YOUR tracks, made from version baseRev. */
  update(owner: string, playerName: string, id: string, file: TrackFile, baseRev: number): LibrarySaveResult {
    return this.tx(() => {
      const row = this.sql.exec<{ owner: string; rev: number; size: number }>(`SELECT owner, rev, size FROM tracks WHERE id = ?`, id).toArray()[0]
      if (!row) return refuse('not-found', "That track isn't in the library any more.")
      if (row.owner !== owner) return refuse('not-yours', "That's somebody else's track, so you can't change it. Copy it and edit your copy instead.")
      if (row.rev !== baseRev) return refuse('changed', 'This track was saved from another computer since this one last looked.', { rev: row.rev })
      if (file.id !== id) return refuse('invalid', "The track's id doesn't match the one it is saved as.")
      const text = JSON.stringify(file)
      const size = utf8Bytes(text)
      if (size > LIBRARY_LIMITS.trackBytes) return refuse('too-big', tooBig(size))
      const { bytes } = this.totals(owner)
      if (bytes - row.size + size > LIBRARY_LIMITS.playerBytes) return refuse('full', FULL)
      const now = this.now()
      const rev = row.rev + 1
      this.remember(owner, playerName)
      this.sql.exec(`UPDATE tracks SET name = ?, file = ?, size = ?, rev = ?, updated = ? WHERE id = ?`, file.name, text, size, rev, now, id)
      return { status: 'ok', id, rev, updated: now, size, movedFrom: null }
    })
  }

  /** Delete one of YOUR tracks. */
  remove(owner: string, id: string): LibraryDeleteResult {
    return this.tx(() => {
      const row = this.sql.exec<{ owner: string }>(`SELECT owner FROM tracks WHERE id = ?`, id).toArray()[0]
      if (!row) return refuse('not-found', "That track isn't in the library any more.")
      if (row.owner !== owner) return refuse('not-yours', "That's somebody else's track, so you can't delete it.")
      this.sql.exec(`DELETE FROM tracks WHERE id = ?`, id)
      return { status: 'ok', id }
    })
  }
}

const FULL = `Your tracks online are full (${LIBRARY_LIMITS.playerBytes / (1024 * 1024)} MB together). Delete one you don't race any more, then this one saves.`

function tooBig(size: number): string {
  return `This track is too big to save online (${Math.ceil(size / 1024)} KB, the most is ${LIBRARY_LIMITS.trackBytes / 1024} KB). A track with fewer road points, props or energy cores will fit.`
}
