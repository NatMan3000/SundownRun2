// ============================================================
//  DRAFT STORE - the track being edited, with undo and redo
// ------------------------------------------------------------
//  Everything Josh does in the editor changes the "draft": the road
//  points, the width, the world, the name. Every change goes through
//  commit(), which:
//    1. remembers the draft as it was (so Undo can bring it back),
//    2. saves a working copy in this browser (so a reload, or a test
//       drive and back, never loses work),
//    3. after a short pause, rebuilds the 3D world from the draft so
//       he sees the real road, terrain and banking as he edits.
//
//  The draft becomes a real track file with draftFile() and is saved
//  with the track registry (src/track/registry.ts), exactly like a
//  built-in track, so a test drive plays it the normal way.
// ============================================================

import { create } from 'zustand'
import type { CoreSpot, EnvironmentSpec, Piece, PropSpot, RoadPoint, TrackFile, TrackIssue } from '../track/schema'
import { getCurrentTrackFile, getTrack, setTrackFromFile } from '../track/current'
import { freeTrackId, getTrackSource, listDrawnTracks, saveDrawnTrack } from '../track/registry'
import { validateTrack } from '../track/validate'
import { startSession } from '../core/session'
import { audio } from '../core/api'
import { BASE_WORLDS, DEFAULT_BASE_WORLD, cloneJson, draftFile, roadBound } from './draftFile'
import { cleanStroke, type CleanResult, type Crossing, type StrokeIssue } from './cleanup'
import type { P } from './geom'

export interface Draft {
  id: string
  name: string
  author: string
  description: string
  points: RoadPoint[]
  width: number
  /** Which base world the environment came from ('custom' = copied from a track file). */
  baseWorld: string
  environment: EnvironmentSpec
  pieces: Piece[]
  props: PropSpot[]
  cores: CoreSpot[]
  startAt: number
}

/** The last clean-up's extras: drawn on the map until the road changes some other way. */
export interface CleanupNotes {
  crossings: Crossing[]
  issues: StrokeIssue[]
}

export interface EditorState {
  draft: Draft
  /** Undo / redo stacks (oldest first). */
  past: Draft[]
  future: Draft[]
  /** True when the draft has changes not yet saved as a track. */
  dirty: boolean
  /** The track id this draft was last saved under, or null if never saved. */
  savedId: string | null
  /** Notes from the last pencil clean-up (crossings, trims...). */
  notes: CleanupNotes | null
  /** What the track validator says about the draft right now. */
  errors: TrackIssue[]
  warnings: TrackIssue[]
  /** 'pending' while the live preview waits to rebuild. */
  preview: 'pending' | 'built' | 'failed'
  /** A short message for the status line (plain words). */
  message: { text: string; tone: 'info' | 'good' | 'warn' | 'bad'; at: number } | null
  tool: 'pencil' | 'pan'
  /** 'edit' = the road editor; 'map' = the read-only world map. */
  mode: 'edit' | 'map'
}

const WORKING_KEY = 'sr2.editor.working.v1'
const HISTORY_MAX = 120

/** A gentle starter oval, so a brand new track always has a road to look at (draw over it to replace it). */
function starterPoints(): RoadPoint[] {
  const pts: RoadPoint[] = []
  const count = 40
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2
    pts.push({ x: Math.round(220 * Math.sin(t) * 10) / 10, z: Math.round(-140 * Math.cos(t) * 10) / 10 })
  }
  return pts
}

export function newDraft(baseWorldId = DEFAULT_BASE_WORLD.id): Draft {
  const base = BASE_WORLDS.find((b) => b.id === baseWorldId) ?? DEFAULT_BASE_WORLD
  return {
    id: '',
    name: 'My Track',
    author: '',
    description: '',
    points: starterPoints(),
    width: 14,
    baseWorld: base.id,
    environment: cloneJson(base.environment),
    pieces: [],
    props: [],
    cores: [],
    startAt: 0,
  }
}

/** Turn any track file (built-in, drawn or imported) into a draft. Built-ins become a copy. */
export function draftFromFile(file: TrackFile, asCopy: boolean): Draft {
  return {
    id: asCopy ? '' : file.id,
    name: asCopy ? `${file.name} copy` : file.name,
    author: file.author ?? '',
    description: file.description ?? '',
    points: cloneJson(file.road.points),
    width: file.road.width ?? 14,
    baseWorld: 'custom',
    environment: cloneJson(file.environment),
    pieces: cloneJson(file.pieces ?? []),
    props: cloneJson(file.props ?? []),
    cores: cloneJson(file.cores ?? []),
    startAt: file.start?.at ?? 0,
  }
}

/** The id a draft previews and saves under (a new draft gets a free one from its name). */
export function draftId(d: Draft): string {
  if (d.id) return d.id
  const taken = new Set(listDrawnTracks().map((t) => t.id))
  const base = freeTrackId(d.name)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`) || getTrackSource(`${base}-${n}`) === 'builtin') n++
  return `${base}-${n}`
}

export function fileFromDraft(d: Draft, id = draftId(d)): TrackFile {
  return draftFile({
    id,
    name: d.name.trim() || 'My Track',
    author: d.author.trim() || undefined,
    description: d.description.trim() || undefined,
    points: d.points,
    width: d.width,
    pieces: d.pieces,
    props: d.props,
    cores: d.cores,
    startAt: d.startAt,
    environment: d.environment,
  })
}

function readWorking(): { draft: Draft; savedId: string | null; dirty: boolean } | null {
  try {
    const raw = localStorage.getItem(WORKING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.draft?.points?.length) return null
    return parsed
  } catch {
    return null
  }
}

function writeWorking(s: Pick<EditorState, 'draft' | 'savedId' | 'dirty'>): void {
  try {
    localStorage.setItem(WORKING_KEY, JSON.stringify({ draft: s.draft, savedId: s.savedId, dirty: s.dirty }))
  } catch (err) {
    console.warn('[editor] could not keep the working copy (browser storage full?)', err)
  }
}

const working = typeof window !== 'undefined' ? readWorking() : null

export const useEditor = create<EditorState>(() => ({
  draft: working?.draft ?? newDraft(),
  past: [],
  future: [],
  dirty: working?.dirty ?? false,
  savedId: working?.savedId ?? null,
  notes: null,
  errors: [],
  warnings: [],
  preview: 'pending',
  message: null,
  tool: 'pencil',
  mode: 'edit',
}))

export function say(text: string, tone: 'info' | 'good' | 'warn' | 'bad' = 'info'): void {
  useEditor.setState({ message: { text, tone, at: performance.now() } })
}

// ---------------------------------------------------------------- changes, undo, redo

/**
 * Make a change to the draft. `change` gets a copy to edit. Every change
 * is undoable and rebuilds the live preview shortly after.
 */
export function commit(change: (d: Draft) => void, notes: CleanupNotes | null = null): void {
  const s = useEditor.getState()
  if (s.mode === 'map') return
  const next = cloneJson(s.draft)
  change(next)
  const past = [...s.past, s.draft].slice(-HISTORY_MAX)
  useEditor.setState({ draft: next, past, future: [], dirty: true, notes })
  writeWorking({ draft: next, savedId: s.savedId, dirty: true })
  schedulePreview()
}

export function undo(): void {
  const s = useEditor.getState()
  if (!s.past.length || s.mode === 'map') return
  const prev = s.past[s.past.length - 1]
  useEditor.setState({ draft: prev, past: s.past.slice(0, -1), future: [s.draft, ...s.future], dirty: true, notes: null })
  writeWorking({ draft: prev, savedId: s.savedId, dirty: true })
  audio.ui('back')
  schedulePreview()
}

export function redo(): void {
  const s = useEditor.getState()
  if (!s.future.length || s.mode === 'map') return
  const next = s.future[0]
  useEditor.setState({ draft: next, past: [...s.past, s.draft], future: s.future.slice(1), dirty: true, notes: null })
  writeWorking({ draft: next, savedId: s.savedId, dirty: true })
  audio.ui('select')
  schedulePreview()
}

/** Start editing a different track (history is cleared: it is a different track). */
export function replaceDraft(draft: Draft, savedId: string | null): void {
  useEditor.setState({ draft, past: [], future: [], dirty: false, savedId, notes: null, mode: 'edit' })
  writeWorking({ draft, savedId, dirty: false })
  previewNow()
}

// ---------------------------------------------------------------- live preview

let previewTimer: ReturnType<typeof setTimeout> | null = null

/** Rebuild the 3D world from the draft after the edits pause for a moment. */
export function schedulePreview(delayMs = 350): void {
  useEditor.setState({ preview: 'pending' })
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(previewNow, delayMs)
}

/** Rebuild the 3D world from the draft right now. Returns the validation result. */
export function previewNow() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = null
  const s = useEditor.getState()
  const file = fileFromDraft(s.draft, s.savedId ?? draftId(s.draft))
  let result
  try {
    result = setTrackFromFile(file)
  } catch (err) {
    console.error('[editor] the track builder threw on the draft', err)
    useEditor.setState({ preview: 'failed', errors: [{ path: '', message: 'The game could not build this track. Try Undo.' }], warnings: [] })
    return null
  }
  useEditor.setState({ preview: result.ok ? 'built' : 'failed', errors: result.errors, warnings: result.warnings })
  return result
}

// ---------------------------------------------------------------- the pencil

/** Options for the clean-up that depend on the draft's world and the zoom it was drawn at. */
export function strokeOptions(d: Draft, metresPerPixel: number) {
  const t = getTrack()
  const sameWorld = t && getCurrentTrackFile() && t.id === (useEditor.getState().savedId ?? draftId(d))
  return {
    width: d.width,
    bound: roadBound(d.environment),
    playRadius: sameWorld ? t.world.playRadius : Infinity,
    // A shaky hand wobbles a few pixels; that is more metres when zoomed out.
    smoothing: Math.min(15, Math.max(5, 7 * metresPerPixel)),
  }
}

/**
 * A finished pencil stroke (world points). It becomes the new road: the
 * clean-up smooths it, opens tight corners, closes the loop and bridges
 * crossings. Pieces are kept, re-anchored by distance along the road.
 */
export function applyStroke(raw: readonly P[], metresPerPixel: number): CleanResult {
  const s = useEditor.getState()
  const res = cleanStroke(raw, strokeOptions(s.draft, metresPerPixel))
  if (!res.ok) {
    const first = res.issues.find((i) => i.level === 'error')
    say(first?.message ?? 'That road could not be cleaned up. Try again.', 'warn')
    audio.ui('error')
    return res
  }
  commit(
    (d) => {
      const oldCount = d.points.length
      d.points = res.points
      d.startAt = 0
      // Keep pieces at the same fraction of the way round the lap.
      if (oldCount > 0) {
        for (const p of d.pieces) p.at = Math.round(((p.at / oldCount) * res.points.length) * 100) / 100
      }
    },
    { crossings: res.crossings, issues: res.issues },
  )
  const bridges = res.crossings.filter((c) => c.over).length
  say(
    `New road: ${(res.length / 1000).toFixed(2)} km, ${res.points.length} points${bridges ? `, ${bridges} bridge${bridges > 1 ? 's' : ''}` : ''}.`,
    'good',
  )
  audio.ui('select')
  return res
}

// ---------------------------------------------------------------- simple field edits

export function setName(name: string): void {
  commit((d) => {
    d.name = name.slice(0, 40)
  })
}
export function setAuthor(author: string): void {
  commit((d) => {
    d.author = author.slice(0, 40)
  })
}
export function setDescription(text: string): void {
  commit((d) => {
    d.description = text.slice(0, 200)
  })
}
export function setWidth(width: number): void {
  commit((d) => {
    d.width = Math.round(Math.min(24, Math.max(10, width)))
  })
}
export function setBaseWorld(id: string): void {
  const base = BASE_WORLDS.find((b) => b.id === id)
  if (!base) return
  commit((d) => {
    d.baseWorld = base.id
    d.environment = cloneJson(base.environment)
  })
}
export function setTimeOfDay(t: number): void {
  commit((d) => {
    d.environment.sky = { ...(d.environment.sky ?? {}), timeOfDay: Math.round(Math.min(1, Math.max(0, t)) * 100) / 100 }
  })
}
export function setEdgeColour(hex: string): void {
  commit((d) => {
    d.environment.palette = { ...(d.environment.palette ?? {}), edge: hex }
  })
}

// ---------------------------------------------------------------- save, test drive

/** Save the draft as a drawn track in this browser. Returns the id, or null if it can't be saved. */
export function saveDraft(): string | null {
  const s = useEditor.getState()
  const id = s.savedId ?? draftId(s.draft)
  const file = fileFromDraft(s.draft, id)
  const v = validateTrack(file)
  if (!v.ok) {
    say(`Can't save yet: ${v.errors[0]?.message ?? 'the track has a problem'}.`, 'bad')
    audio.ui('error')
    useEditor.setState({ errors: v.errors, warnings: v.warnings })
    return null
  }
  if (!saveDrawnTrack(file)) {
    say('Could not save: this browser is out of storage space.', 'bad')
    audio.ui('error')
    return null
  }
  const draft = { ...s.draft, id }
  useEditor.setState({ draft, savedId: id, dirty: false })
  writeWorking({ draft, savedId: id, dirty: false })
  say(`Saved "${file.name}".`, 'good')
  return id
}

/** Validate, save, build and drive it. The pause menu's Road Editor button comes back here. */
export function testDrive(): boolean {
  const id = saveDraft()
  if (!id) return false
  const s = useEditor.getState()
  const result = setTrackFromFile(fileFromDraft(s.draft, id))
  if (!result.ok) {
    say(`Can't drive it: ${result.errors[0]?.message ?? 'the track has a problem'}.`, 'bad')
    return false
  }
  audio.ui('start')
  return startSession({ mode: 'free', trackId: id })
}

/**
 * Called when the editor opens. Keeps unsaved work; otherwise, if the
 * game is on a drawn track (he was test-driving it), edit that one.
 */
export function onEditorOpen(mode: 'edit' | 'map'): void {
  const s = useEditor.getState()
  const current = getCurrentTrackFile()
  if (mode === 'map') {
    useEditor.setState({ mode: 'map', notes: null })
    return
  }
  useEditor.setState({ mode: 'edit' })
  if (current && !s.dirty && current.id !== s.savedId && getTrackSource(current.id) === 'drawn') {
    replaceDraft(draftFromFile(current, false), current.id)
    return
  }
  previewNow()
}
