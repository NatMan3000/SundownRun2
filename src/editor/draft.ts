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
//       he sees the real road, terrain and banking as he edits, and
//       runs the game's own track checks on it (checks.ts), so the
//       Checks panel agrees with `bun run tracks:check`.
//
//  The draft becomes a real track file with fileFromDraft() and is saved
//  with the track registry (src/track/registry.ts), exactly like a
//  built-in track, so a test drive plays it the normal way.
//
//  A draft with no road points is the empty map (a new track, or after
//  Clear all): the pencil's first loop, Random track or Drive to draw
//  give it a road, and until then every road tool says so instead.
// ============================================================

import { create } from 'zustand'
import { TRACK_DEFAULTS, type CoreSpot, type EnvironmentSpec, type HuntSpec, type Piece, type PropSpot, type RoadPoint, type RoadSpec, type TrackFile, type TrackIssue } from '../track/schema'
import { getCurrentTrackFile, getTrack, setTrackFromFile } from '../track/current'
import type { TrackGate } from '../track/gates'
import { freeTrackId, getTrackSource, listDrawnTracks, saveDrawnTrack } from '../track/registry'
import { validateTrack } from '../track/validate'
import { startSession } from '../core/session'
import { audio } from '../core/api'
import { BASE_WORLDS, DEFAULT_BASE_WORLD, clearedDraft, cloneJson, draftFromFile, emptyWorldFile, fileOfDraft, isBlankDraft, isEmptyDraft, pointGroundOf, roadBound, worldForCopy } from './draftFile'
import { randomTrack } from './randomTrack'
import { cleanStroke, type CleanResult, type Crossing, type StrokeIssue } from './cleanup'
import { checkBuiltTrack, gateItems } from './checks'
import { crossingNear, keepOverOf, roadCrossings, swapDraft } from './bridges'
import { keepBridgesClear } from './bankBridges'
import type { P } from './geom'
import { type PlaceKind, makeCore, makeProp, makeRoadPiece, toolFor } from './pieces'
import { atAfterDelete, atAfterInsert, frameAt, metresBetween, nearestLoopSpot, nearestOnRoad, planRedraw, reanchor, roadCurve, wrapAt, LOOP_RUN_IN } from './road'
import {
  type ShapeResult,
  type ShapeWorld,
  type Splice,
  BEND_REACH,
  MIN_RADIUS,
  STEADY_DEFAULT,
  STEADY_STRING,
  alongRoad,
  atOf,
  bendRoad,
  closestPoints,
  bendWeight,
  cornerRadius,
  curveStretch,
  densify,
  fairStretch,
  nearestStraightStart,
  newPointHeight,
  openCornersOnStretch,
  roadLine,
  roadRoughness,
  SHAPE_SPACING,
  sOf,
  smoothRoad as smoothShape,
  spliceRoad,
  startGridStraight,
  straightStretch,
  stretchOf,
  tightestBetween,
} from './shape'

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
  /**
   * The rest of the road's settings from its track file, kept exactly as they
   * are: how its corners bank (how steep, for what speed, and a live bank
   * slider like the Hyperdrome's) and its barrier walls. A new drawing has none:
   * it banks automatically and has no walls.
   */
  roadSettings?: RoadSettings
  /** Laps in a race, if the track says (otherwise the player's own setting). */
  laps?: number
  /** The energy-core hunt: how many cores each round (otherwise all of them, up to 12). */
  hunt?: HuntSpec
}

/** Everything about a track file's road except its points and width (see Draft.roadSettings). */
export type RoadSettings = Omit<RoadSpec, 'points' | 'width'>

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
  /**
   * The game's own track checks (src/track/gates.ts, the same rows `bun run
   * tracks:check` prints) on the last built preview. null until the first build.
   */
  gates: TrackGate[] | null
  /** The draft the gates (and errors/warnings) were worked out for; the verdict only counts while it is still the draft. */
  checkedDraft: Draft | null
  /** How long the last gate run took, ms. */
  gatesMs: number
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
  /** The Bend tool's reach: metres of road either side of your hand that come with it. */
  bendReach: number
  /** The pencil's steady hand (an index into STEADY_STRING in shape.ts: 0 = off). */
  steady: number
  /** A Straight or Curve half made: the spots clicked so far (`at` values). */
  shaping: Shaping | null
}

export type EditorTool = 'pencil' | 'bend' | 'straight' | 'curve' | 'select' | 'place' | 'section'

/** Straight or Curve, part way through: `a` is the first click, `b` the second (Curve only, then you pull). */
export interface Shaping {
  tool: 'straight' | 'curve'
  a: number
  b: number | null
}

/**
 * Something selected on the map. A section runs from `from` to `to` going
 * forward (both are `at` values). A crossing (where the road goes over or
 * under itself) is remembered by its spot on the map: swapping which road is
 * on top changes heights, not where the roads cross, so the spot stays good.
 * A problem from the Checks list is remembered by its key.
 */
export type Selection =
  | { kind: 'piece'; index: number }
  | { kind: 'point'; index: number }
  | { kind: 'prop'; index: number }
  | { kind: 'core'; index: number }
  | { kind: 'section'; from: number; to: number }
  | { kind: 'crossing'; x: number; z: number }
  /** A row of the Checks list (or its pin on the map), by its key (problems.ts). */
  | { kind: 'problem'; key: string }

const WORKING_KEY = 'sr2.editor.working.v1'
const HISTORY_MAX = 120

/** A brand new track: an empty map in the chosen world (draw a loop with the pencil, or press Random track). */
export function newDraft(baseWorldId = DEFAULT_BASE_WORLD.id): Draft {
  const base = BASE_WORLDS.find((b) => b.id === baseWorldId) ?? DEFAULT_BASE_WORLD
  return {
    id: '',
    name: 'My Track',
    author: '',
    description: '',
    points: [],
    width: 14,
    baseWorld: base.id,
    environment: cloneJson(base.environment),
    pieces: [],
    props: [],
    cores: [],
    startAt: 0,
  }
}

/** Turn a track file into a draft (built-ins become a copy that keeps everything): see draftFile.ts. */
export { draftFromFile }

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

/** The track file this draft makes (see fileOfDraft), under its own id unless one is given. */
export function fileFromDraft(d: Draft, id = draftId(d)): TrackFile {
  return fileOfDraft(d, id)
}

function readWorking(): { draft: Draft; savedId: string | null; dirty: boolean } | null {
  try {
    const raw = localStorage.getItem(WORKING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // An empty map (no road yet) is a real draft too: keep its name and world.
    if (!Array.isArray(parsed?.draft?.points)) return null
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

/** Tool settings (Bend's reach, the pencil's steady hand) are remembered in this browser too. */
const PREFS_KEY = 'sr2.editor.prefs.v1'

function readPrefs(): { bendReach: number; steady: number } {
  const fallback = { bendReach: BEND_REACH.start, steady: STEADY_DEFAULT }
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null
    if (!raw) return fallback
    const p = JSON.parse(raw)
    const reach = Number(p?.bendReach)
    const steady = Number(p?.steady)
    return {
      bendReach: Number.isFinite(reach) ? Math.min(BEND_REACH.max, Math.max(BEND_REACH.min, reach)) : fallback.bendReach,
      steady: Number.isInteger(steady) && steady >= 0 && steady < STEADY_STRING.length ? steady : fallback.steady,
    }
  } catch {
    return fallback
  }
}

function writePrefs(): void {
  const s = useEditor.getState()
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ bendReach: s.bendReach, steady: s.steady }))
  } catch (err) {
    console.warn('[editor] could not remember the tool settings (browser storage full?)', err)
  }
}

const prefs = readPrefs()

export const useEditor = create<EditorState>(() => ({
  draft: working?.draft ?? newDraft(),
  past: [],
  future: [],
  dirty: working?.dirty ?? false,
  savedId: working?.savedId ?? null,
  notes: null,
  errors: [],
  warnings: [],
  gates: null,
  checkedDraft: null,
  gatesMs: 0,
  preview: 'pending',
  message: null,
  tool: 'pencil',
  placeKind: 'boost',
  selection: null,
  mode: 'edit',
  bendReach: prefs.bendReach,
  steady: prefs.steady,
  shaping: null,
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
  useEditor.setState({ draft: next, past, future: [], dirty: true, notes, shaping: null })
  writeWorking({ draft: next, savedId: s.savedId, dirty: true })
  schedulePreview()
}

export function undo(): void {
  const s = useEditor.getState()
  if (!s.past.length || s.mode === 'map') return
  const prev = s.past[s.past.length - 1]
  useEditor.setState({ draft: prev, past: s.past.slice(0, -1), future: [s.draft, ...s.future], dirty: true, notes: null, selection: null, shaping: null })
  writeWorking({ draft: prev, savedId: s.savedId, dirty: true })
  audio.ui('back')
  schedulePreview()
}

export function redo(): void {
  const s = useEditor.getState()
  if (!s.future.length || s.mode === 'map') return
  const next = s.future[0]
  useEditor.setState({ draft: next, past: [...s.past, s.draft], future: s.future.slice(1), dirty: true, notes: null, selection: null, shaping: null })
  writeWorking({ draft: next, savedId: s.savedId, dirty: true })
  audio.ui('select')
  schedulePreview()
}

/** Start editing a different track (history is cleared: it is a different track). */
export function replaceDraft(draft: Draft, savedId: string | null): void {
  useEditor.setState({ draft, past: [], future: [], dirty: false, savedId, notes: null, mode: 'edit', selection: null, shaping: null })
  writeWorking({ draft, savedId, dirty: false })
  previewNow()
}

// ---------------------------------------------------------------- live preview

let previewTimer: ReturnType<typeof setTimeout> | null = null

/** Forget a rebuild that is still waiting (leaving the editor: the game's track must not change behind the title screen). */
export function cancelPendingPreview(): void {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = null
}

/** Rebuild the 3D world from the draft after the edits pause for a moment. */
export function schedulePreview(delayMs = 350): void {
  useEditor.setState({ preview: 'pending' })
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(previewNow, delayMs)
}

/**
 * Rebuild the 3D world from the draft right now, then run the game's track
 * checks on what was built (checks.ts). Returns the validation result.
 */
export function previewNow() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = null
  const s = useEditor.getState()
  if (isEmptyDraft(s.draft)) return previewEmptyMap(s.draft)
  const file = fileFromDraft(s.draft, s.savedId ?? draftId(s.draft))
  let result
  try {
    result = setTrackFromFile(file)
  } catch (err) {
    console.error('[editor] the track builder threw on the draft', err)
    useEditor.setState({ preview: 'failed', errors: [{ path: '', message: 'The game could not build this track. Try Undo.' }], warnings: [], gates: [], checkedDraft: s.draft })
    return null
  }
  if (!result.ok) {
    // Nothing was built (the current track is still the old one), so there is nothing to gate.
    useEditor.setState({ preview: 'failed', errors: result.errors, warnings: result.warnings, gates: [], checkedDraft: s.draft })
    return result
  }
  // Same rows as `bun run tracks:check` (10-100 ms; this already runs debounced after edits).
  const run = checkBuiltTrack(getTrack())
  useEditor.setState({ preview: 'built', errors: result.errors, warnings: result.warnings, gates: run.gates, gatesMs: run.ms, checkedDraft: s.draft })
  tellIfShapeBrokeChecks(s.draft, run.gates)
  return result
}

/**
 * The empty map: build its world around the hidden stand-in loop
 * (draftFile.ts emptyWorldFile), so the hills, sky and city show under the
 * map while there is no road. There is nothing to check yet: no errors, no
 * gate rows, and the Checks panel says there is no road.
 */
function previewEmptyMap(draft: Draft) {
  let result
  try {
    result = setTrackFromFile(emptyWorldFile(draft, useEditor.getState().savedId ?? draftId(draft)))
  } catch (err) {
    console.error('[editor] the track builder threw on the empty world', err)
    result = null
  }
  if (!result?.ok) {
    useEditor.setState({ preview: 'failed', errors: [{ path: '', message: "The game couldn't build this world. Pick another world in the panel." }], warnings: [], gates: [], checkedDraft: draft })
    return result
  }
  useEditor.setState({ preview: 'built', errors: [], warnings: [], gates: [], gatesMs: 0, checkedDraft: draft })
  return result
}

/** True when the draft has no road yet (a cleared map, or a new track). */
export function mapIsEmpty(): boolean {
  return isEmptyDraft(useEditor.getState().draft)
}

/** What the map, the tools and the status line say while there is no road. */
export const EMPTY_MAP_HINT = 'There is no road yet. Draw a loop with the pencil, or press Random track.'

/**
 * A shaping tool's change, waiting for the game's checks: `failingBefore` are
 * the checks that already failed before it. See tellIfShapeBrokeChecks.
 */
let shapeWatch: { what: string; draft: Draft; failingBefore: string[] } | null = null

/** Remember the checks failing right now, so the rebuild after a shaping change can tell what is new. */
function failingNow(): string[] {
  const s = useEditor.getState()
  if (s.checkedDraft !== s.draft || !s.gates) return []
  return s.gates.filter((g) => g.level === 'fail').map((g) => g.name)
}

/**
 * Straight after the rebuild that follows a shaping change: if one of the
 * game's own checks now fails that didn't before (for example a bend so sharp
 * the auto-banking can't follow it), say so at once, in its plain words, with
 * what to do. The Checks panel and its pin on the map say the same.
 */
function tellIfShapeBrokeChecks(draft: Draft, gates: readonly TrackGate[]): void {
  const watch = shapeWatch
  if (!watch || watch.draft !== draft) return
  shapeWatch = null
  const fresh = gates.filter((g) => g.level === 'fail' && !watch.failingBefore.includes(g.name))
  if (!fresh.length) return
  const item = gateItems(gates, draft, roadCurve(draft.points)).find((it) => it.tone === 'bad')
  say(`${watch.what} made a problem the game's checks don't like: ${item?.title ?? 'see Checks'} Undo puts it back, or see Checks for what to do.`, 'warn')
  audio.ui('error')
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

/** The one short line the pencil says when you let go of a line that changes nothing (road.ts planRedraw). */
export const PENCIL_NOTHING: Record<'start' | 'end' | 'together' | 'short', string> = {
  start: 'Nothing changed: start your line on the road, then end it back on the road.',
  end: 'Nothing changed: end your line back on the road to redraw the bit in between.',
  together: 'Nothing changed: end your line further along the road (a whole new road starts from Clear all).',
  short: 'Nothing changed: draw a longer line, from the road back to the road.',
}

/**
 * A finished pencil stroke (world points). The pencil always edits the road
 * that is there:
 *   - on an empty map it draws the road: the clean-up smooths it, opens
 *     tight corners, closes the loop and bridges crossings
 *   - on a map with a road, a line from the road back to the road redraws
 *     the stretch between its ends (road.ts planRedraw)
 *   - any other line changes nothing, and the status line says how to use it
 */
export function applyStroke(raw: readonly P[], metresPerPixel: number): CleanResult {
  const s = useEditor.getState()
  if (!isEmptyDraft(s.draft)) {
    const plan = planRedraw(raw, s.draft.points, s.draft.width)
    if (plan.kind === 'redraw') return applySectionRedraw(plan.loop, metresPerPixel)
    say(PENCIL_NOTHING[plan.why], 'warn')
    audio.ui('error')
    return { ok: false, points: [], dense: [], length: 0, tightestRadius: 0, crossings: [], issues: [{ level: 'error', code: 'too-few-points', message: PENCIL_NOTHING[plan.why] }] }
  }
  const res = cleanStroke(raw, strokeOptions(s.draft, metresPerPixel))
  if (!res.ok) {
    const first = res.issues.find((i) => i.level === 'error')
    say(first?.message ?? 'That road could not be cleaned up. Try again.', 'warn')
    audio.ui('error')
    return res
  }
  commit(
    (d) => {
      // The map was empty, so there are no pieces to keep (Clear all took them with the road).
      d.points = res.points
      d.startAt = 0
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
  if (isEmptyDraft(s.draft)) {
    say("There's no road to save yet. Draw a loop with the pencil, or press Random track.", 'warn')
    audio.ui('error')
    return null
  }
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
  // Same road, new id: the checks already run on it still count.
  useEditor.setState({ draft, savedId: id, dirty: false, checkedDraft: s.checkedDraft === s.draft ? draft : s.checkedDraft })
  writeWorking({ draft, savedId: id, dirty: false })
  say(`Saved "${file.name}".`, 'good')
  return id
}

/** Validate, save, build and drive it. The pause menu's Road Editor button comes back here. */
export function testDrive(): boolean {
  if (isEmptyDraft(useEditor.getState().draft)) {
    say("There's no road to drive yet. Draw a loop with the pencil, or press Random track.", 'warn')
    audio.ui('error')
    return false
  }
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
  // Every crossing that is still there keeps the road it had on top (a swapped bridge stays swapped).
  const keepOver = keepOverOf(s.draft.points, pointGroundFor(s.draft))
  const res = cleanStroke(loop, { ...strokeOptions(s.draft, metresPerPixel), fairing: 0, keepOver })
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
  const flipped = res.issues.find((i) => i.code === 'bridge-flipped')
  say(flipped ? `Redrew that stretch of road. ${flipped.message}` : 'Redrew that stretch of road.', flipped ? 'warn' : 'good')
  audio.ui(flipped ? 'error' : 'select')
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
  useEditor.setState({ tool, placeKind: placeKind ?? s.placeKind, selection: tool === s.tool ? s.selection : null, shaping: tool === s.tool ? s.shaping : null })
}

/** Drop the current place tool's thing at world point q. Returns true if something was placed. */
export function placeAt(q: P): boolean {
  const s = useEditor.getState()
  const d = s.draft
  const kind = s.placeKind
  const tool = toolFor(kind)
  if (isEmptyDraft(d)) {
    say(EMPTY_MAP_HINT, 'info')
    return false
  }
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
    let note = `${tool.label} placed.`
    if (piece.type === 'loop') {
      // A loop needs a straight, level run-in either side or cars hit it instead of riding it.
      const spot = loopSpot(hit.at)
      if (spot === null) {
        say(`A loop needs a straight, flat stretch about ${LOOP_RUN_IN * 2} m long, and this road hasn't got one. Draw a longer straight first.`, 'warn')
        audio.ui('error')
        return false
      }
      const moved = Math.min(metresBetween(rc, hit.at, spot), metresBetween(rc, spot, hit.at))
      if (moved > 3) note = `Loops need a straight, flat run-in, so it went on the nearest straight, ${Math.round(moved)} m away.`
      piece.at = Math.round(spot * 100) / 100
    }
    commit((x) => {
      x.pieces.push(piece)
    })
    useEditor.setState({ selection: { kind: 'piece', index: useEditor.getState().draft.pieces.length - 1 } })
    say(note, 'good')
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
  if (sel.kind === 'section' || sel.kind === 'crossing' || sel.kind === 'problem') return
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

/** Add a road point at `at` (on the curve, and at the road's own height there, so the road does not move). */
export function insertPointAt(at: number): void {
  if (noRoadYet()) return
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
  const ground = pointGroundFor(d)
  commit((x) => {
    const before = x.points[k]
    const after = x.points[(k + 1) % count]
    const point: RoadPoint = { x: Math.round(where.x * 10) / 10, z: Math.round(where.z * 10) / 10 }
    if (ground) {
      // Exactly the height the road has here now (points on built-in tracks can be 200 m apart).
      Object.assign(point, newPointHeight(x.points, a, point, ground))
    } else {
      const lift = (before.lift ?? 0) * (1 - t) + (after.lift ?? 0) * t
      if (lift > 0.05) point.lift = Math.round(lift * 10) / 10
    }
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

/**
 * Smooth: iron the wobbles and kinks out of the whole road (shape.ts
 * smoothRoad). Every point, piece and per-point setting stays; the points
 * slide onto a smoother line, and no corner ends up tighter than a car can
 * take. Each press is one Undo step and smoother than the last. Returns how
 * wobbly the road was before and after (see roadRoughness).
 */
export function smoothRoad(): { before: number; after: number } {
  const s = useEditor.getState()
  if (isEmptyDraft(s.draft)) {
    say(EMPTY_MAP_HINT, 'info')
    return { before: 0, after: 0 }
  }
  const before = roadRoughness(s.draft.points)
  // Loops need their straight run-in and the start grid needs straight road: Smooth leaves those alone.
  const keep = [
    ...s.draft.pieces.flatMap((p) => (p.type === 'loop' ? [{ at: p.at, before: LOOP_RUN_IN + 20, after: 2.6 * (p.radius ?? TRACK_DEFAULTS.loopRadius) + 40 }] : [])),
    { at: s.draft.startAt, before: 60, after: 15 },
  ]
  const res = smoothShape(s.draft.points, shapeWorld(s.draft), undefined, keep)
  const after = roadRoughness(res.points)
  const moved = Math.max(0, ...res.points.map((p, i) => Math.hypot(p.x - s.draft.points[i].x, p.z - s.draft.points[i].z)))
  if (moved < 0.1) {
    say('The road is already as smooth as Smooth can make it.', 'info')
    return { before, after: before }
  }
  const failingBefore = failingNow()
  commit((d) => {
    const old = d.points
    d.points = res.points
    carryAlongside(d, old, res.mapAt)
  })
  shapeWatch = { what: 'Smoothing', draft: useEditor.getState().draft, failingBefore }
  const less = Math.round(100 * (1 - after / Math.max(before, 1e-9)))
  say(
    less >= 5
      ? `Smoothed: the road is ${less}% less wobbly. Press it again for smoother still, or Undo.${res.notes.length ? ` ${res.notes.join(' ')}` : ''}`
      : `Smoothed a little (it was already smooth). Press it again for more, or Undo.${res.notes.length ? ` ${res.notes.join(' ')}` : ''}`,
    'good',
  )
  audio.ui('select')
  return { before, after }
}

// ---------------------------------------------------------------- shaping tools: Bend, Straight, Curve

/**
 * What the shaping maths needs to know about this draft's world: its edge,
 * the road width, and the ground its road points sit on, so every point a
 * tool adds keeps the road at exactly the height it had.
 */
export function shapeWorld(d: Draft): ShapeWorld {
  const o = strokeOptions(d, 1)
  return { width: d.width, bound: o.bound, playRadius: o.playRadius, pointGround: pointGroundFor(d) }
}

/**
 * The ground a road point with no `y` sits on in this draft's world (see
 * pointGroundOf), under the id the live preview builds it with.
 */
export function pointGroundFor(d: Draft): ((x: number, z: number) => number) | undefined {
  // The map asks every frame (for its bridge labels), so it is worked out once per environment object.
  // Every commit copies the draft (a new environment object), and the id can only change by a
  // commit (a new name) or by saving, which keeps the id the preview already used.
  const memo = groundMemo.get(d.environment)
  if (memo) return memo.ground
  const ground = pointGroundOf(d.environment, useEditor.getState().savedId ?? draftId(d))
  groundMemo.set(d.environment, { ground })
  return ground
}

/** pointGroundFor's answers, kept per environment object. */
const groundMemo = new WeakMap<EnvironmentSpec, { ground: ((x: number, z: number) => number) | undefined }>()

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/**
 * Crash props and energy cores beside the road stay beside it when the road
 * moves: each one within 40 m of the old road keeps its distance from the
 * same spot on the new road. `mapAt` says where each old spot went.
 */
export function carryAlongside(d: Draft, oldPoints: RoadPoint[], mapAt: (at: number) => number): void {
  const oldRc = roadCurve(oldPoints)
  const newRc = roadCurve(d.points)
  const move = (spot: { x: number; z: number }) => {
    const hit = nearestOnRoad(oldRc, spot)
    if (hit.distance > d.width / 2 + 40) return
    const f = frameAt(newRc, mapAt(hit.at))
    const x = Math.round((f.p.x + f.right.x * hit.lateral) * 10) / 10
    const z = Math.round((f.p.z + f.right.z * hit.lateral) * 10) / 10
    if (Math.hypot(x - spot.x, z - spot.z) < 0.2) return
    spot.x = x
    spot.z = z
  }
  for (const p of d.props) move(p)
  for (const c of d.cores) move(c)
}

/**
 * The start grid needs straight road. If a change bent the road under a grid
 * that was straight before, the start line moves to the nearest straight.
 * Returns how far it moved (metres), or 0.
 */
function keepStartOnStraight(d: Draft, gridWasStraight: boolean): number {
  if (!gridWasStraight || startGridStraight(d.points, d.startAt)) return 0
  const spot = nearestStraightStart(d.points, d.startAt, d.pieces)
  if (spot === null) return 0
  const line = roadLine(d.points)
  const metres = alongRoad(sOf(line, d.startAt), sOf(line, spot), line.length)
  d.startAt = Math.round(spot * 100) / 100
  return metres
}

/**
 * Make a finished Straight, Curve or Corner the draft: one Undo step. Pieces
 * and the start line move to the same places on the new road, props and
 * cores beside it come along. Returns false (and says why) if it was refused.
 */
export function commitShape(res: ShapeResult, done: string, what = 'That change'): boolean {
  if (!res.ok) {
    say(res.reason ?? 'That did not work. Try other spots.', 'warn')
    audio.ui('error')
    return false
  }
  const failingBefore = failingNow()
  let startMoved = 0
  commit((d) => {
    const old = d.points
    const gridWasStraight = startGridStraight(old, d.startAt)
    d.points = res.points
    for (const p of d.pieces) p.at = round3(res.mapAt(p.at))
    d.startAt = round3(res.mapAt(d.startAt))
    carryAlongside(d, old, res.mapAt)
    startMoved = keepStartOnStraight(d, gridWasStraight)
  })
  const extra = [...res.notes]
  if (startMoved > 1) extra.push(`The start line moved ${Math.round(startMoved)} m to stay on a straight.`)
  say(`${done}${extra.length ? ` ${extra.join(' ')}` : ''}`, 'good')
  audio.ui('select')
  shapeWatch = { what, draft: useEditor.getState().draft, failingBefore }
  return true
}

/** On an empty map the road tools have nothing to work on: say how to get a road. True if the map is empty. */
function noRoadYet(): boolean {
  if (!isEmptyDraft(useEditor.getState().draft)) return false
  say(EMPTY_MAP_HINT, 'info')
  return true
}

/** Straight: the road between two spots (`at` values) becomes a straight line. */
export function applyStraight(fromAt: number, toAt: number): boolean {
  if (noRoadYet()) return false
  const d = useEditor.getState().draft
  const res = straightStretch(d.points, fromAt, toAt, shapeWorld(d))
  return commitShape(res, 'Straightened that stretch of road.', 'That straight')
}

/** Curve: the road between two spots becomes one smooth curve through `pull`. */
export function applyCurve(fromAt: number, toAt: number, pull: P): boolean {
  if (noRoadYet()) return false
  const d = useEditor.getState().draft
  const res = curveStretch(d.points, fromAt, toAt, pull, shapeWorld(d))
  return commitShape(res, 'Made that stretch one smooth curve.', 'That curve')
}

/**
 * Corner: the corner around road point `index` gets a new radius (bigger is
 * gentler, smaller is tighter); its ends stay put. The same corner stays
 * selected (the road has new points there now).
 */
export function applyCornerRadius(index: number, radius: number): boolean {
  if (noRoadYet()) return false
  const d = useEditor.getState().draft
  const res = cornerRadius(d.points, index, radius, shapeWorld(d))
  const at = res.ok ? res.mapAt(index) : index
  if (!commitShape(res, 'Changed the corner.', 'That corner change')) return false
  const count = useEditor.getState().draft.points.length
  useEditor.setState({ selection: { kind: 'point', index: Math.round(at) % count } })
  return true
}

/** Esc, or a different tool: forget a half-made Straight or Curve. Returns true if there was one. */
export function cancelShaping(): boolean {
  if (!useEditor.getState().shaping) return false
  useEditor.setState({ shaping: null })
  say('Cancelled.', 'info')
  return true
}

/** Change Bend's reach (metres either way), kept within its limits and remembered. */
export function setBendReach(metres: number): void {
  const reach = Math.round(Math.min(BEND_REACH.max, Math.max(BEND_REACH.min, metres)))
  if (reach === useEditor.getState().bendReach) return
  useEditor.setState({ bendReach: reach })
  writePrefs()
}

/** The pencil's steady hand: 0 (off) to STEADY_STRING.length - 1 (a lot). Remembered. */
export function setSteady(level: number): void {
  const steady = Math.max(0, Math.min(STEADY_STRING.length - 1, Math.round(level)))
  useEditor.setState({ steady })
  writePrefs()
}

// ---------------------------------------------------------------- Bend: grab the road and pull (one undo step per drag)

/**
 * A bend in progress: where the road was grabbed (`grabAt` on the road before
 * the drag, `grabNow` on the evened road being bent), the draft before the
 * drag, the pull so far, its world, and the game's checks failing before it.
 */
let bendDrag: { grabAt: number; grabNow: number; grab: P; start: Draft; pull: P; world: ShapeWorld; failingBefore: string[] } | null = null

/** What the map draws for a bend in progress (see bendState). */
export interface BendView {
  /** The moving stretch of road, centreline, every 4 m or so. */
  line: P[]
  /** How much of the pull each spot of `line` gets (1 at the hand, 0 at the reach). */
  weights: number[]
  /** Where the bent road is tighter than a car can take, or null. */
  tight: P | null
  tightRadius: number
}

/** True while a bend drag is going on. */
export function isBending(): boolean {
  return bendDrag !== null
}

/** Start bending: the road was grabbed at `at` (the spot under the pointer is `grab`). */
export function beginBend(at: number, grab: P): void {
  if (noRoadYet()) return
  beginGesture()
  const start = useEditor.getState().draft
  bendDrag = { grabAt: at, grabNow: at, grab, start, pull: { x: 0, z: 0 }, world: shapeWorld(start), failingBefore: failingNow() }
}

/**
 * The pointer moved to `to` (or the reach changed): bend the road from where
 * it was when the drag began. Built-in tracks have points far apart, so the
 * stretch first gets extra points on the same curve (densify) to bend smoothly.
 */
export function moveBend(to?: P): BendView | null {
  const drag = bendDrag
  if (!drag) return null
  if (to) drag.pull = { x: to.x - drag.grab.x, z: to.z - drag.grab.z }
  const s = useEditor.getState()
  const reach = s.bendReach
  const start = drag.start
  const world = drag.world
  // Built-in tracks have points far apart: give the road even, close points first (same road).
  const line0 = roadLine(start.points)
  const dense = densify(line0, 0, line0.length, 20, undefined, world)
  const line1 = roadLine(dense.points)
  drag.grabNow = dense.mapAt(drag.grabAt)
  const grabS = sOf(line1, drag.grabNow)
  const points = bendRoad(line1, grabS, reach, drag.pull, world)
  liveChange((d) => {
    d.points = points
    d.pieces = start.pieces.map((p) => ({ ...p, at: round3(dense.mapAt(p.at)) }))
    d.startAt = round3(dense.mapAt(start.startAt))
    d.props = start.props.map((p) => ({ ...p }))
    d.cores = start.cores.map((c) => ({ ...c }))
    carryAlongside(d, start.points, dense.mapAt)
  })
  return bendView(points, grabS, reach)
}

/** The highlighted stretch for a bend (or, before pressing, for where it would grab). */
export function bendView(points: RoadPoint[], grabS: number, reach: number): BendView {
  const line = roadLine(points)
  const pts = stretchOf(line, grabS - reach, grabS + reach, 4)
  const weights = pts.map((_, i) => bendWeight(-reach + (2 * reach * i) / Math.max(1, pts.length - 1), reach))
  const t = tightestBetween(line, grabS - reach - 10, grabS + reach + 10)
  return { line: pts, weights, tight: t.radius < MIN_RADIUS ? t.at : null, tightRadius: t.radius }
}

/** Esc during a bend: put the road back as it was and forget the drag. */
export function cancelBend(): boolean {
  const drag = bendDrag
  if (!drag) return false
  bendDrag = null
  liveChange((d) => Object.assign(d, cloneJson(drag.start)))
  endGesture()
  say('Bend cancelled.', 'info')
  return true
}

/**
 * Let go of a bend: one Undo step. If the bend is too tight for a car, or
 * squeezed the road points together (a pull along the road with a short
 * reach), the bent stretch is laid out again with even points and the
 * clean-up's corner rule opens it out. If even that can't make it drivable
 * (the road folded over itself), the bend is put back and Josh is told why.
 * The start line moves to a straight if the bend put its grid on a curve.
 */
export function endBend(): void {
  const drag = bendDrag
  bendDrag = null
  if (!drag) return
  const putBack = (text: string, tone: 'info' | 'warn') => {
    liveChange((d) => Object.assign(d, cloneJson(drag.start)))
    endGesture()
    say(text, tone)
  }
  if (Math.hypot(drag.pull.x, drag.pull.z) < 0.3) {
    // A click, not a drag: nothing changes (and no Undo step).
    putBack('Hold the mouse button down on the road and drag to bend it.', 'info')
    return
  }
  const s = useEditor.getState()
  const reach = s.bendReach
  const line = roadLine(s.draft.points)
  const grabS = sOf(line, drag.grabNow)
  const s0 = grabS - reach - 20
  const s1 = grabS + reach + 20
  const tight = tightestBetween(line, s0 + 10, s1 - 10).radius < MIN_RADIUS
  const bunched = closestPoints(s.draft.points) < 4
  /** Is the road drivable across the bent stretch (no corner too tight, no points squeezed together)? */
  const drivable = (sp: Splice | null) => {
    const points = sp ? sp.points : s.draft.points
    const after = roadLine(points)
    const a0 = sOf(after, sp ? sp.mapAt(atOf(line, s0)) : atOf(line, s0))
    let a1 = sOf(after, sp ? sp.mapAt(atOf(line, s1)) : atOf(line, s1))
    if (a1 <= a0) a1 += after.length
    return { tight: tightestBetween(after, a0, a1).radius >= MIN_RADIUS, spaced: closestPoints(points) >= 2.5 }
  }
  let fixed: Splice | null = null
  let ok = drivable(null)
  if (tight || bunched) {
    // Lay the bent stretch out again with even points and open the tight bit, a little wider each try.
    // The fairing after it (16 m) lets the opened corner flow into the road either side, so the
    // game's banking has room to roll in and out (a quicker join made it lean the wrong way).
    for (const grow of [1.35, 1.6, 1.9]) {
      const win = openCornersOnStretch(stretchOf(line, s0, s1, 2), MIN_RADIUS * grow)
      fixed = spliceRoad(line, s0, s1, fairStretch(win, 16), SHAPE_SPACING, drag.world)
      ok = drivable(fixed)
      if (ok.tight && ok.spaced) break
    }
  }
  if (!ok.tight || !ok.spaced) {
    putBack(
      ok.spaced
        ? 'That bend is too sharp for a car, even opened out, so it was put back. Pull less, or roll the mouse wheel for a longer reach.'
        : 'That bend folded the road over itself, so it was put back. Pull less, or roll the mouse wheel for a longer reach.',
      'warn',
    )
    audio.ui('error')
    return
  }
  let startMoved = 0
  liveChange((d) => {
    if (fixed) {
      const old = d.points
      d.points = fixed.points
      for (const p of d.pieces) p.at = round3(fixed.mapAt(p.at))
      d.startAt = round3(fixed.mapAt(d.startAt))
      carryAlongside(d, old, fixed.mapAt)
    }
    startMoved = keepStartOnStraight(d, startGridStraight(drag.start.points, drag.start.startAt))
  })
  endGesture()
  shapeWatch = { what: 'That bend', draft: useEditor.getState().draft, failingBefore: drag.failingBefore }
  const notes: string[] = []
  if (fixed && tight) notes.push('It was too tight for a car there, so the clean-up opened it out a little.')
  if (startMoved > 1) notes.push(`The start line moved ${Math.round(startMoved)} m to stay on a straight.`)
  say(notes.length ? `Bent the road. ${notes.join(' ')}` : 'Bent the road. Undo if you want it back.', 'good')
  audio.ui('select')
}

/**
 * Clear all: wipe the map back to empty (no road, pieces, props, cores or
 * start line; see clearedDraft) so Josh can start again with the pencil or
 * Random track. It is ONE commit, so one Undo brings the whole track back exactly.
 *
 * Only the open draft changes. Tracks saved in the library and the built-in
 * tracks are never touched; a saved track only changes if he presses Save
 * (or Test drive) afterwards, like any other edit. The working copy kept in
 * this browser follows along: commit() writes the cleared draft, and Undo
 * writes the old one back. Returns false if there was nothing to clear.
 */
export function clearAll(): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  if (isBlankDraft(s.draft)) {
    say(`Already clear. ${EMPTY_MAP_HINT}`, 'info')
    return false
  }
  commit((d) => {
    Object.assign(d, clearedDraft(d))
  })
  useEditor.setState({ selection: null, tool: 'pencil' })
  say('Cleared. Draw a loop with the pencil or press Random track for your new road, or Undo to bring the old one back.', 'good')
  audio.ui('back')
  return true
}

/**
 * Random track: a whole new road in this world (randomTrack.ts), that has
 * already passed every check the game has. It replaces the road, pieces,
 * start line, props and cores (the world, name and settings stay), as ONE
 * commit, so one Undo brings back what was there. `seed` picks the track
 * (the same seed, the same track); without one the dice are rolled.
 * Returns how many shapes it tried and how long it took, or null if none
 * passed (then nothing changes).
 */
export function randomRoad(seed = Math.floor(Math.random() * 2 ** 32)): { tries: number; ms: number; shape: string } | null {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return null
  const d = s.draft
  const id = s.savedId ?? draftId(d)
  const t = getTrack()
  const res = randomTrack(d, {
    seed,
    id,
    // The live preview's world (the empty map's world too) is built under the same id: its edge is known.
    playRadius: t && t.id === id ? t.world.playRadius : undefined,
    params: t && t.id === id ? { ...t.params } : {},
  })
  if (!res.ok || !res.pick) {
    say("The dice didn't find a good road this time. Press Random track again.", 'warn')
    audio.ui('error')
    return null
  }
  const pick = res.pick
  commit((x) => {
    x.points = pick.points
    x.pieces = pick.pieces
    x.startAt = pick.startAt
    x.props = []
    x.cores = []
  })
  useEditor.setState({ selection: null })
  // Build it straight away (the button should feel instant): it already passed the checks.
  previewNow()
  const km = (pick.length / 1000).toFixed(2)
  const what = { blob: 'a swoopy loop', eight: 'a figure eight', bowtie: 'a bow tie', circuit: 'a circuit', peanut: 'a peanut-shaped loop' }[pick.shape]
  const extras = [pick.bridges ? `${pick.bridges === 1 ? 'a bridge' : `${pick.bridges} bridges`}` : '', pick.pieces.some((p) => p.type === 'speedtrap') ? 'a speed trap' : '', pick.pieces.some((p) => p.type === 'boost') ? 'a boost pad' : ''].filter(Boolean)
  const list = extras.length > 1 ? `${extras.slice(0, -1).join(', ')} and ${extras[extras.length - 1]}` : extras[0]
  say(`Random track: ${what}, ${km} km${list ? ` with ${list}` : ''}. Press it again for another, or Undo.`, 'good')
  audio.ui('select')
  return { tries: res.tries, ms: res.ms, shape: pick.shape }
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
  if (noRoadYet()) return
  let words = ''
  const moved: { mapAt: ((at: number) => number) | null } = { mapAt: null }
  commit((d) => {
    const old = d.points.map((p) => ({ ...p }))
    for (const i of sectionPoints(d.points.length, from, to)) {
      if (deg === null) delete d.points[i].bank
      else d.points[i].bank = Math.round(deg)
    }
    // A bank lifts the road's middle (it tilts about its low edge): a bridge over this stretch goes up with it (bankBridges.ts).
    const kept = keepBridgesClear(old, d.points, d.pieces, d.startAt, d.width, pointGroundFor(d) ?? flatGround)
    if (kept.points !== d.points && kept.words) {
      d.points = kept.points
      for (const p of d.pieces) p.at = round3(kept.mapAt(p.at))
      d.startAt = round3(kept.mapAt(d.startAt))
      carryAlongside(d, old, kept.mapAt)
      moved.mapAt = kept.mapAt
    }
    words = kept.words
  })
  // The road was evened out to raise the bridge: the same stretch stays selected.
  const sel = useEditor.getState().selection
  const map = moved.mapAt
  if (map && sel?.kind === 'section') useEditor.setState({ selection: { kind: 'section', from: round3(map(from)), to: round3(map(to)) } })
  if (words) say(words, /couldn't|too low/.test(words) ? 'warn' : 'good')
}

/** Set (or with null, clear back to the track's width) the road width on a stretch. */
export function setSectionWidth(from: number, to: number, width: number | null): void {
  if (noRoadYet()) return
  commit((d) => {
    for (const i of sectionPoints(d.points.length, from, to)) {
      if (width === null) delete d.points[i].width
      else d.points[i].width = Math.round(Math.min(24, Math.max(10, width)))
    }
  })
}

// ---------------------------------------------------------------- bridges: which road goes over

/** Every place the draft's road crosses itself, with which road is on top (see bridges.ts). */
export function draftCrossings(d: Draft = useEditor.getState().draft) {
  return roadCrossings(d.points, pointGroundFor(d) ?? flatGround)
}

/** Heights with no known world: just the lifts (only before the world's ground can be worked out). */
const flatGround = () => 0

/** Select the crossing at (or nearest within 30 m of) a map spot. Returns false if there is none there. */
export function selectCrossing(spot: P): boolean {
  const hit = crossingNear(draftCrossings(), spot)
  if (!hit) return false
  useEditor.setState({ selection: { kind: 'crossing', x: hit.crossing.at.x, z: hit.crossing.at.z } })
  audio.ui('select')
  return true
}

/**
 * Swap which road goes over at the crossing nearest `spot` (bridges.ts
 * swapDraft): the road on top comes down to the ground there and the other
 * rises over it on the clean-up's ramps. One commit, so one Undo puts it
 * back. If it can't be done cleanly, nothing changes and Josh is told why.
 */
export function swapBridge(spot: P): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const d = s.draft
  const id = s.savedId ?? draftId(d)
  const t = getTrack()
  const built = s.checkedDraft === d && s.preview === 'built' && !!s.gates && t?.id === id
  const res = swapDraft(d, spot, {
    id,
    pointGround: pointGroundFor(d),
    // The same live settings (a bank slider) the preview builds with.
    params: t && t.id === id ? { ...t.params } : {},
    gatesBefore: built ? s.gates ?? undefined : undefined,
  })
  if (!res.ok || !res.draft) {
    say(res.reason ?? "Can't swap this bridge.", 'warn')
    audio.ui('error')
    return false
  }
  const next = res.draft
  commit((x) => {
    x.points = next.points
    x.pieces = next.pieces
    x.startAt = next.startAt
  })
  say(res.done ?? 'Swapped.', 'good')
  audio.ui('select')
  return true
}

// ---------------------------------------------------------------- environment

/** Use the world (ground, sky, city, music) of another track: exactly its hills too (see worldForCopy). */
export function copyEnvironmentFrom(file: TrackFile): void {
  commit((d) => {
    d.baseWorld = `copy:${file.id}`
    d.environment = worldForCopy(file)
  })
  say(`Using the world from "${file.name}".`, 'good')
}

/** How far the road (and anything dragged) may reach from the centre in this draft's world, metres. */
export function roadBoundFor(): number {
  return roadBound(useEditor.getState().draft.environment) - 10
}

/**
 * Where a loop near `at` can go: the nearest spot with a straight run-in
 * either side (no bend tighter than a 500 m radius within 70 m, measured
 * finely so kinks show) on level road (under 2 m of rise or fall either
 * side, read from the built preview when it is this draft).
 */
export function loopSpot(at: number): number | null {
  const s = useEditor.getState()
  const rc = roadCurve(s.draft.points)
  const t = getTrack()
  const built = t && t.id === (s.savedId ?? draftId(s.draft)) ? t : null
  const level = (a: number) => {
    if (!built) return true
    const p = frameAt(rc, a).p
    const hit = built.nearest(p.x, 0, p.z, { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false })
    const S = built.samples
    const i0 = hit.index
    const step = Math.round(LOOP_RUN_IN / S.ds)
    const y = (k: number) => S.py[(((i0 + k) % S.count) + S.count) % S.count]
    return Math.abs(y(-step) - y(0)) < 2 && Math.abs(y(step) - y(0)) < 2
  }
  return nearestLoopSpot(rc, at, level)
}

/** Where piece `index` was when the current drag began (to put it back). */
export function gestureStartAt(index: number): number | null {
  return gestureStart?.pieces[index]?.at ?? null
}
