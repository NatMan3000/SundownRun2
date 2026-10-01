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
//    shared   - a multiplayer host's track, streamed in (memory only
//               until the player chooses to keep it).
// ============================================================

import type { TrackFile, ValidationResult } from './schema'
import { validateTrack } from './validate'

export type TrackSource = 'builtin' | 'drawn' | 'shared'

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
  try {
    localStorage.setItem(DRAWN_KEY, JSON.stringify(all))
    return true
  } catch (err) {
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

/** Every playable track: built-in first, then drawn, then shared. */
export function listTracks(): TrackListing[] {
  const list = builtins()
  for (const file of Object.values(readDrawn())) {
    list.push({ id: file.id, name: file.name, author: file.author, description: file.description, source: 'drawn', file })
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
  return writeDrawn(all)
}

export function deleteDrawnTrack(id: string): void {
  const all = readDrawn()
  delete all[id]
  writeDrawn(all)
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

/** Multiplayer: hold a track streamed from the host (memory only). */
export function registerSharedTrack(file: TrackFile): void {
  shared.set(file.id, file)
}
