// ============================================================
//  TRACK REGISTRY - every track the game knows about
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned API; track worker may extend).
//
//  Three sources, one format (src/track/schema.ts):
//    builtin  - every tracks/*.json file, bundled at build time.
//               Drop a file in tracks/ and it appears in the game.
//    drawn    - tracks made in the road editor (or imported), saved
//               in this browser's localStorage.
//    library  - online only: other players' tracks from the online
//               track library (src/editor/library/sync.ts keeps them
//               here, memory only). Your own library tracks are drawn.
//    shared   - a multiplayer host's track, streamed in (memory only
//               until the player chooses to keep it).
//
//  Every save or delete of a drawn track is announced to the
//  onDrawnTracksChanged listeners (the online library uploads it).
// ============================================================

import { dropAllGhosts } from '../core/ghostStore'
import type { TrackFile, ValidationResult } from './schema'
import { validateTrack } from './validate'

export type TrackSource = 'builtin' | 'drawn' | 'library' | 'shared'

export interface TrackListing {
  id: string
  name: string
  author?: string
  description?: string
  source: TrackSource
  file: TrackFile
}

const builtinModules = import.meta.glob('../../tracks/*.json', { eager: true, import: 'default' }) as Record<
  string,
  TrackFile
>

/** Built-in tracks in display order: the launch tracks first, then alphabetical. */
const LAUNCH_ORDER = ['afterglow', 'hyperdrome']

const DRAWN_KEY = 'sr2.tracks.drawn.v1'

const shared = new Map<string, TrackFile>()
/** A shared track held under another id than the host's: the host's id, for its key (keyIdFor). */
const sharedHostId = new WeakMap<TrackFile, string>()

/** Other players' tracks from the online library, with whose they are (display name). */
const library = new Map<string, { file: TrackFile; owner: string }>()

export type DrawnChange = { kind: 'save'; file: TrackFile } | { kind: 'delete'; id: string }
const drawnListeners = new Set<(change: DrawnChange) => void>()

/** Hear about every drawn track saved or deleted in this browser. Returns the unsubscribe. */
export function onDrawnTracksChanged(listener: (change: DrawnChange) => void): () => void {
  drawnListeners.add(listener)
  return () => drawnListeners.delete(listener)
}

function announce(change: DrawnChange): void {
  for (const l of drawnListeners) {
    try {
      l(change)
    } catch (err) {
      console.error('[tracks] a drawn-track listener failed', err)
    }
  }
}

function readDrawn(): Record<string, TrackFile> {
  try {
    const raw = localStorage.getItem(DRAWN_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDrawn(all: Record<string, TrackFile>): boolean {
  const text = JSON.stringify(all)
  try {
    localStorage.setItem(DRAWN_KEY, text)
    return true
  } catch (err) {
    // Full: old ghost laps are what gives way, a saved track never does. Try once more with them gone.
    if (dropAllGhosts() > 0) {
      try {
        localStorage.setItem(DRAWN_KEY, text)
        return true
      } catch {
        // fall through to the report below
      }
    }
    console.error('[tracks] could not save drawn tracks (storage full or unavailable)', err)
    return false
  }
}

function builtins(): TrackListing[] {
  const out: TrackListing[] = []
  for (const file of Object.values(builtinModules)) {
    if (!file || typeof file !== 'object' || typeof file.id !== 'string') continue
    out.push({ id: file.id, name: file.name, author: file.author, description: file.description, source: 'builtin', file })
  }
  out.sort((a, b) => {
    const ia = LAUNCH_ORDER.indexOf(a.id)
    const ib = LAUNCH_ORDER.indexOf(b.id)
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Every playable track: built-in first, then drawn, then library, then shared. An id already listed is never listed twice. */
export function listTracks(): TrackListing[] {
  const list = builtins()
  for (const file of Object.values(readDrawn())) {
    list.push({ id: file.id, name: file.name, author: file.author, description: file.description, source: 'drawn', file })
  }
  for (const { file, owner } of library.values()) {
    if (list.some((l) => l.id === file.id)) continue
    list.push({ id: file.id, name: file.name, author: owner, description: file.description, source: 'library', file })
  }
  for (const file of shared.values()) {
    if (list.some((l) => l.id === file.id)) continue
    list.push({ id: file.id, name: file.name, author: file.author, description: file.description, source: 'shared', file })
  }
  return list
}

export function getTrackFile(id: string): TrackFile | null {
  return listTracks().find((t) => t.id === id)?.file ?? null
}

export function getTrackSource(id: string): TrackSource | null {
  return listTracks().find((t) => t.id === id)?.source ?? null
}

function isBuiltinId(id: string): boolean {
  return builtins().some((t) => t.id === id)
}

/** Make an id that doesn't clash with a built-in track. */
export function freeTrackId(base: string): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-track'
  if (!isBuiltinId(clean)) return clean
  let n = 2
  while (isBuiltinId(`${clean}-${n}`)) n++
  return `${clean}-${n}`
}

/** Save (or overwrite) a drawn track in this browser. Returns false if storage failed. */
export function saveDrawnTrack(file: TrackFile): boolean {
  const all = readDrawn()
  all[file.id] = file
  if (!writeDrawn(all)) return false
  announce({ kind: 'save', file })
  return true
}

export function deleteDrawnTrack(id: string): void {
  const all = readDrawn()
  if (!(id in all)) return
  delete all[id]
  if (writeDrawn(all)) announce({ kind: 'delete', id })
}

/**
 * Online library: replace the other players' tracks this browser knows
 * (memory only; the library keeps its own copy). Each entry carries the
 * owner's display name, shown as the track's author.
 */
export function setLibraryTracks(entries: readonly { file: TrackFile; owner: string }[]): void {
  library.clear()
  for (const e of entries) library.set(e.file.id, { file: e.file, owner: e.owner })
}

export function listDrawnTracks(): TrackFile[] {
  return Object.values(readDrawn())
}

/** Pretty JSON exactly as it would sit in tracks/<id>.json. */
export function exportTrackJson(file: TrackFile): string {
  return JSON.stringify(file, null, 2) + '\n'
}

/** Download a track as <id>.json (for swapping with friends or dropping into tracks/). */
export function downloadTrack(file: TrackFile): void {
  const blob = new Blob([exportTrackJson(file)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${file.id}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Import a track file's text. Validates it; on success saves it as a drawn
 * track (renaming the id if it clashes with a built-in) and returns the result.
 */
export function importTrackJson(text: string): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: `Not valid JSON: ${(err as Error).message}` }], warnings: [] }
  }
  const result = validateTrack(parsed)
  if (result.ok && result.track) {
    const file = parsed as TrackFile
    if (isBuiltinId(file.id)) file.id = freeTrackId(file.id)
    if (!saveDrawnTrack(file)) {
      return { ok: false, errors: [{ path: '', message: 'Could not save: browser storage is full.' }], warnings: result.warnings }
    }
  }
  return result
}

/**
 * Multiplayer: hold a track streamed from the host (memory only). `hostId` is the id the host
 * has it under, when it is held here under another one (a joiner's own track has that id).
 */
export function registerSharedTrack(file: TrackFile, hostId: string = file.id): void {
  shared.set(file.id, file)
  if (hostId !== file.id) sharedHostId.set(file, hostId)
  else sharedHostId.delete(file)
  // Another player's library track under its own id: the host's copy is the one being raced, so
  // hold that one (the library refreshes it from its own copy at its next sync).
  const held = library.get(file.id)
  if (held) library.set(file.id, { file, owner: held.owner })
}

/**
 * The id that goes in a track's key (TrackRuntime.keyId): its own id, except a host's track
 * held here under another id, which keeps the host's, so both players' copies share one key.
 */
export function keyIdFor(file: TrackFile): string {
  return sharedHostId.get(file) ?? file.id
}
