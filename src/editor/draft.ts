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
import { type PlaceKind, makeCore, makeProp, makeRoadPiece, toolFor } from './pieces'
import { atAfterDelete, atAfterInsert, frameAt, nearestOnRoad, reanchor, roadCurve, sectionRedraw, wrapAt } from './road'

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
  tool: EditorTool
  /** What the place tool drops. */
  placeKind: PlaceKind
  /** The thing selected on the map (select, place and section tools). */
  selection: Selection | null
  /** 'edit' = the road editor; 'map' = the read-only world map. */
  mode: 'edit' | 'map'
}

export type EditorTool = 'pencil' | 'pan' | 'select' | 'place' | 'section'

/** Something selected on the map. A section runs from `from` to `to` going forward (both are `at` values). */
export type Selection =
  | { kind: 'piece'; index: number }
  | { kind: 'point'; index: number }
  | { kind: 'prop'; index: number }
  | { kind: 'core'; index: number }
  | { kind: 'section'; from: number; to: number }

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
  placeKind: 'boost',
  selection: null,
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
  useEditor.setState({ draft: prev, past: s.past.slice(0, -1), future: [s.draft, ...s.future], dirty: true, notes: null, selection: null })
  writeWorking({ draft: prev, savedId: s.savedId, dirty: true })
  audio.ui('back')
  schedulePreview()
}

export function redo(): void {
  const s = useEditor.getState()
  if (!s.future.length || s.mode === 'map') return
  const next = s.future[0]
  useEditor.setState({ draft: next, past: [...s.past, s.draft], future: s.future.slice(1), dirty: true, notes: null, selection: null })
  writeWorking({ draft: next, savedId: s.savedId, dirty: true })
  audio.ui('select')
  schedulePreview()
}

/** Start editing a different track (history is cleared: it is a different track). */
export function replaceDraft(draft: Draft, savedId: string | null): void {
  useEditor.setState({ draft, past: [], future: [], dirty: false, savedId, notes: null, mode: 'edit', selection: null })
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
    // Zoomed in close, small wiggles are deliberate, so both passes smooth less.
    smoothing: Math.min(18, Math.max(5, 10 * metresPerPixel)),
    fairing: Math.min(18, Math.max(5, 10 * metresPerPixel)),
  }
}

/**
 * A finished pencil stroke (world points). It becomes the new road: the
 * clean-up smooths it, opens tight corners, closes the loop and bridges
 * crossings. Pieces are kept, re-anchored by distance along the road.
 */
export function applyStroke(raw: readonly P[], metresPerPixel: number): CleanResult {
  const s = useEditor.getState()
  const section = sectionRedraw(raw, s.draft.points, s.draft.width)
  if (section) return applySectionRedraw(section, metresPerPixel)
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

// ---------------------------------------------------------------- redraw part of the road

function applySectionRedraw(loop: P[], metresPerPixel: number): CleanResult {
  const s = useEditor.getState()
  const res = cleanStroke(loop, { ...strokeOptions(s.draft, metresPerPixel), fairing: 0 })
  if (!res.ok) {
    say(res.issues.find((i) => i.level === 'error')?.message ?? 'That redraw did not work. Try again.', 'warn')
    audio.ui('error')
    return res
  }
  const oldRc = roadCurve(s.draft.points)
  const newRc = roadCurve(res.points)
  commit(
    (d) => {
      // Keep per-point bank and width overrides where the road did not move.
      const oldPoints = d.points
      d.points = res.points.map((p) => {
        const near = oldPoints.find((o) => Math.hypot(o.x - p.x, o.z - p.z) < 6)
        const out = { ...p }
        if (near?.bank !== undefined) out.bank = near.bank
        if (near?.width !== undefined) out.width = near.width
        return out
      })
      for (const piece of d.pieces) piece.at = reanchor(oldRc, newRc, piece.at)
      d.startAt = reanchor(oldRc, newRc, d.startAt)
    },
    { crossings: res.crossings, issues: res.issues },
  )
  say('Redrew that stretch of road.', 'good')
  audio.ui('select')
  return res
}

// ---------------------------------------------------------------- drag gestures (one undo step per drag)

let gestureStart: Draft | null = null

/** Start a drag: the draft as it is now is what Undo will bring back. */
export function beginGesture(): void {
  gestureStart = useEditor.getState().draft
}

/** Change the draft during a drag (no undo step, no rebuild yet). */
export function liveChange(change: (d: Draft) => void): void {
  const s = useEditor.getState()
  const next = cloneJson(s.draft)
  change(next)
  useEditor.setState({ draft: next, dirty: true })
}

/** Finish a drag: one undo step, then rebuild the 3D preview. */
export function endGesture(): void {
  const start = gestureStart
  gestureStart = null
  if (!start) return
  const s = useEditor.getState()
  if (JSON.stringify(start) === JSON.stringify(s.draft)) return
  useEditor.setState({ past: [...s.past, start].slice(-HISTORY_MAX), future: [], notes: null })
  writeWorking({ draft: s.draft, savedId: s.savedId, dirty: true })
  schedulePreview(60)
}

// ---------------------------------------------------------------- placing and editing pieces

export function setTool(tool: EditorTool, placeKind?: PlaceKind): void {
  const s = useEditor.getState()
  useEditor.setState({ tool, placeKind: placeKind ?? s.placeKind, selection: tool === s.tool ? s.selection : null })
}

/** Drop the current place tool's thing at world point q. Returns true if something was placed. */
export function placeAt(q: P): boolean {
  const s = useEditor.getState()
  const d = s.draft
  const kind = s.placeKind
  const tool = toolFor(kind)
  if (tool.onRoad) {
    const rc = roadCurve(d.points)
    const hit = nearestOnRoad(rc, q)
    if (hit.distance > d.width / 2 + 12) {
      say(`Click on the road to put a ${tool.label.toLowerCase()} there.`, 'warn')
      audio.ui('error')
      return false
    }
    if (kind === 'start') {
      commit((x) => {
        x.startAt = Math.round(hit.at * 100) / 100
      })
      say('Moved the start line.', 'good')
      audio.ui('select')
      return true
    }
    const piece = makeRoadPiece(kind, hit, d.width / 2)
    if (!piece) return false
    commit((x) => {
      x.pieces.push(piece)
    })
    useEditor.setState({ selection: { kind: 'piece', index: useEditor.getState().draft.pieces.length - 1 } })
    say(`${tool.label} placed.`, 'good')
    audio.ui('select')
    return true
  }
  if (kind === 'props') {
    commit((x) => {
      x.props.push(makeProp(q))
    })
    useEditor.setState({ selection: { kind: 'prop', index: useEditor.getState().draft.props.length - 1 } })
  } else {
    commit((x) => {
      x.cores.push(makeCore(q))
    })
    useEditor.setState({ selection: { kind: 'core', index: useEditor.getState().draft.cores.length - 1 } })
  }
  say(`${tool.label} placed.`, 'good')
  audio.ui('select')
  return true
}

/** Delete whatever is selected (a piece, prop, core or road point). */
export function deleteSelection(): void {
  const s = useEditor.getState()
  const sel = s.selection
  if (!sel) return
  if (sel.kind === 'point') {
    deletePoint(sel.index)
    return
  }
  if (sel.kind === 'section') return
  commit((d) => {
    if (sel.kind === 'piece') d.pieces.splice(sel.index, 1)
    if (sel.kind === 'prop') d.props.splice(sel.index, 1)
    if (sel.kind === 'core') d.cores.splice(sel.index, 1)
  })
  useEditor.setState({ selection: null })
  audio.ui('back')
}

export function updatePiece(index: number, change: (p: Piece) => void): void {
  commit((d) => {
    const p = d.pieces[index]
    if (p) change(p)
  })
}
export function updateProp(index: number, change: (p: PropSpot) => void): void {
  commit((d) => {
    const p = d.props[index]
    if (p) change(p)
  })
}
export function updateCore(index: number, change: (p: CoreSpot) => void): void {
  commit((d) => {
    const p = d.cores[index]
    if (p) change(p)
  })
}

// ---------------------------------------------------------------- road points

/** Add a road point at `at` (on the curve, so the road does not move). */
export function insertPointAt(at: number): void {
  const s = useEditor.getState()
  const d = s.draft
  const count = d.points.length
  const a = wrapAt(at, count)
  const k = Math.floor(a)
  const t = a - k
  if (t < 0.08 || t > 0.92) {
    say('There is already a point there.', 'info')
    return
  }
  const where = frameAt(roadCurve(d.points), a).p
  const index = k + 1
  commit((x) => {
    const before = x.points[k]
    const after = x.points[(k + 1) % count]
    const point: RoadPoint = { x: Math.round(where.x * 10) / 10, z: Math.round(where.z * 10) / 10 }
    const lift = (before.lift ?? 0) * (1 - t) + (after.lift ?? 0) * t
    if (lift > 0.05) point.lift = Math.round(lift * 10) / 10
    if (before.bank !== undefined && after.bank !== undefined) point.bank = Math.round((before.bank * (1 - t) + after.bank * t) * 10) / 10
    if (before.width !== undefined && after.width !== undefined) point.width = Math.round(before.width * (1 - t) + after.width * t)
    x.points.splice(index, 0, point)
    for (const p of x.pieces) p.at = atAfterInsert(p.at, index, t)
    x.startAt = atAfterInsert(x.startAt, index, t)
  })
  useEditor.setState({ selection: { kind: 'point', index } })
  audio.ui('select')
}

export function deletePoint(index: number): void {
  const s = useEditor.getState()
  const count = s.draft.points.length
  if (count <= 8) {
    say('A road needs at least 8 points. Redraw it instead.', 'warn')
    audio.ui('error')
    return
  }
  commit((x) => {
    x.points.splice(index, 1)
    for (const p of x.pieces) p.at = atAfterDelete(p.at, index, count)
    x.startAt = atAfterDelete(x.startAt, index, count)
  })
  useEditor.setState({ selection: null })
  audio.ui('back')
}

/** Gently even out the whole road (keeps every point, piece and setting). */
export function smoothRoad(): void {
  commit((d) => {
    const n = d.points.length
    for (let pass = 0; pass < 2; pass++) {
      for (const k of [0.5, -0.53]) {
        const src = d.points.map((p) => ({ x: p.x, z: p.z }))
        for (let i = 0; i < n; i++) {
          const a = src[(i - 1 + n) % n]
          const c = src[(i + 1) % n]
          d.points[i].x = Math.round((src[i].x + k * ((a.x + c.x) / 2 - src[i].x)) * 10) / 10
          d.points[i].z = Math.round((src[i].z + k * ((a.z + c.z) / 2 - src[i].z)) * 10) / 10
        }
      }
    }
  })
  say('Smoothed the road a little. Press it again for more, or Undo.', 'good')
}

// ---------------------------------------------------------------- sections: bank and width

/** Indices of the road points inside a section (at least the nearest one). */
export function sectionPoints(count: number, from: number, to: number): number[] {
  const span = wrapAt(to - from, count)
  const out: number[] = []
  for (let i = 0; i < count; i++) if (wrapAt(i - from, count) <= span) out.push(i)
  if (!out.length) out.push(Math.round(wrapAt(from + span / 2, count)) % count)
  return out
}

/** Set (or with null, clear back to automatic) the bank in degrees on a stretch of road. */
export function setSectionBank(from: number, to: number, deg: number | null): void {
  commit((d) => {
    for (const i of sectionPoints(d.points.length, from, to)) {
      if (deg === null) delete d.points[i].bank
      else d.points[i].bank = Math.round(deg)
    }
  })
}

/** Set (or with null, clear back to the track's width) the road width on a stretch. */
export function setSectionWidth(from: number, to: number, width: number | null): void {
  commit((d) => {
    for (const i of sectionPoints(d.points.length, from, to)) {
      if (width === null) delete d.points[i].width
      else d.points[i].width = Math.round(Math.min(24, Math.max(10, width)))
    }
  })
}

// ---------------------------------------------------------------- environment

/** Use the world (ground, sky, city, music) of another track. */
export function copyEnvironmentFrom(file: TrackFile): void {
  commit((d) => {
    d.baseWorld = `copy:${file.id}`
    d.environment = cloneJson(file.environment)
  })
  say(`Using the world from "${file.name}".`, 'good')
}

/** How far the road (and anything dragged) may reach from the centre in this draft's world, metres. */
export function roadBoundFor(): number {
  return roadBound(useEditor.getState().draft.environment) - 10
}
