// ============================================================
//  STRETCH TOOLS - Height, Bank and Width, wired to the editor
// ------------------------------------------------------------
//  Each of the three tools works on a stretch of road (a `section`
//  selection). Josh picks one by dragging along the road, or by
//  clicking it:
//
//    a click on a change he made before (a raised stretch, a bank,
//    a width) picks up that whole stretch with its value showing,
//    ready to change or put back (stretchRuns.ts finds them)
//    a click anywhere else picks a sensible stretch around it
//
//  Clicking a RAISED, BANK or WIDTH label on the map does the same
//  with any tool: it switches to that label's tool.
//
//  The Height slider only offers heights that build: its ends are
//  worked out by building the road and running the game's checks
//  (raise.ts heightLimitSteps), a build at a time between frames so
//  the editor never freezes. heightLimitsNow() hands the panel what
//  is known so far for the stretch on screen.
//
//  The Height tool's "Smooth the bumps here" (smoothStretch) lays the
//  picked stretch on a smooth line through the ground (smooth.ts).
//
//  The Height tool builds tunnels too (its panel's "Make it a tunnel").
//  With it, the pointer over a tunnel shows TUNNEL 150 m and a click
//  picks the tunnel's covered stretch, so its roof can come off or its
//  length change right there (tunnelAtSpot).
// ============================================================

import { audio } from '../core/api'
import { getTrack } from '../track/current'
import { type Draft, commit, draftId, mapIsEmpty, pointGroundFor, say, setTool, useEditor, EMPTY_MAP_HINT } from './draft'
import { liveRuntime } from './fixActions'
import { type HeightLimits, type RaiseOptions, groundDraft, heightLimitSteps } from './raise'
import { smoothDraft } from './smooth'
import { TRACK_DEFAULTS } from '../track/schema'
import { advanceAt, metresBetween, roadCurve } from './road'
import { type StretchMarks, type StretchRun, type StretchTool, bankStretchAround, heightStretchAround, resizeStretch, runAt, stretchMarks, stretchMetres, widthStretchAround } from './stretchRuns'

/** Heights with no known world (only before the ground can be worked out): just the lifts. */
const flatGround = () => 0

/** The runs on the draft's road (what the map marks, and what a click can pick up again). */
export function marksOf(d: Draft): StretchMarks {
  return stretchMarks(d.points, pointGroundFor(d) ?? flatGround)
}

/** What each tool says when a click picks up a change made before. */
function runWords(run: StretchRun): string {
  if (run.tool === 'bank') return `Picked the bank you set: ${Math.round(run.value)}°. Change it in the panel, or press Auto to let the game bank it again.`
  if (run.tool === 'width') return `Picked the width you set: ${Math.round(run.value)} m. Change it in the panel, or press Track width to put it back.`
  if (run.value < 0) return `Picked the dug road: ${Math.round(-run.value * 10) / 10} m down at its deepest. Change its height in the panel, or press On the ground to put it back up.`
  return `Picked the raised road: ${Math.round(run.value * 10) / 10} m up at its highest. Change its height in the panel, or press On the ground to put it back down.`
}

/** What to do next, once a new stretch is picked. */
const NEXT: Record<StretchTool, string> = {
  height: 'Now set its height in the panel.',
  bank: 'Now set its bank in the panel.',
  width: 'Now set its width in the panel.',
}

/** Select a run (a change made before) in its own tool, with its value showing in the panel. */
export function selectRun(run: StretchRun): void {
  setTool(run.tool)
  useEditor.setState({ selection: { kind: 'section', from: run.from, to: run.to } })
  say(runWords(run), 'info')
  audio.ui('select')
}

/**
 * A click with the Height, Bank or Width tool at `at` on the road: the change
 * already there if the click is on one (the whole stretch), otherwise a
 * sensible new stretch around it (stretchRuns.ts).
 */
export function pickStretchAt(tool: StretchTool, at: number): void {
  if (mapIsEmpty()) {
    say(EMPTY_MAP_HINT, 'info')
    return
  }
  const d = useEditor.getState().draft
  const pick = stretchToPick(tool, d, at)
  if (pick.tunnel) {
    // A tunnel, with the Height tool: its covered stretch, ready to change its length or take its roof off.
    if (useEditor.getState().tool !== tool) setTool(tool)
    useEditor.setState({ selection: { kind: 'section', from: pick.from, to: pick.to } })
    say(`Picked the tunnel: ${Math.round(pick.tunnel.length)} m of road under a roof. Change its length, or take the roof off, in the panel.`, 'info')
    audio.ui('select')
    return
  }
  if (pick.run) {
    selectRun(pick.run)
    return
  }
  const sel = { from: pick.from, to: pick.to }
  if (useEditor.getState().tool !== tool) setTool(tool)
  useEditor.setState({ selection: { kind: 'section', ...sel } })
  const metres = Math.round(stretchMetres(d.points, sel.from, sel.to))
  const what = tool === 'bank' ? (metres > 85 ? `the corner here (${metres} m of road)` : `${metres} m of road`) : `${metres} m of road`
  say(`Picked ${what}. ${NEXT[tool]} Drag along the road instead to pick your own stretch.`, 'info')
  audio.ui('select')
}

/**
 * What a click at `at` with `tool` would pick: the change already there (its
 * run), or a sensible new stretch around it. The map shows this while the
 * pointer is over the road, before any click (the hover preview).
 */
export function stretchToPick(tool: StretchTool, d: Draft, at: number): { from: number; to: number; run: StretchRun | null; tunnel?: TunnelSpot } {
  // With the Height tool, a tunnel under the pointer is what a click picks (its covered stretch).
  const tunnel = tool === 'height' ? tunnelAtSpot(d, at) : null
  if (tunnel) return { from: tunnel.from, to: tunnel.to, run: null, tunnel }
  const run = runAt(marksOf(d), tool, at, d.points.length)
  if (run) return { from: run.from, to: run.to, run }
  const sel =
    tool === 'height' ? heightStretchAround(d, at, liveRuntime(), pointGroundFor(d) ?? flatGround) : tool === 'bank' ? bankStretchAround(d.points, at) : widthStretchAround(d.points, at)
  return { ...sel, run: null }
}

/** The hover preview's words: how long the stretch is, and what a click does with it. */
export function stretchHoverLabel(d: Draft, pick: { from: number; to: number; run: StretchRun | null; tunnel?: TunnelSpot }): string {
  if (pick.tunnel) return `TUNNEL ${Math.round(pick.tunnel.length)} m`
  const metres = Math.round(stretchMetres(d.points, pick.from, pick.to))
  if (!pick.run) return `${metres} m`
  const r = pick.run
  const what = r.tool === 'bank' ? `BANK ${Math.round(r.value)}°` : r.tool === 'width' ? `WIDTH ${Math.round(r.value)} m` : r.value < 0 ? `DUG ${Math.round(-r.value * 2) / 2} m` : `RAISED ${Math.round(r.value * 2) / 2} m`
  return `${what}, ${metres} m`
}

/** A Tunnel piece on the road: its index in the draft's pieces, and the stretch its roof covers (`at` values). */
export interface TunnelSpot {
  index: number
  from: number
  to: number
  length: number
}

/** The Tunnel piece whose roof covers spot `at` on the road, or null. */
export function tunnelAtSpot(d: Draft, at: number): TunnelSpot | null {
  if (!d.pieces.some((p) => p.type === 'tunnel')) return null
  const rc = roadCurve(d.points)
  for (let index = 0; index < d.pieces.length; index++) {
    const p = d.pieces[index]
    if (p.type !== 'tunnel') continue
    const length = p.length ?? TRACK_DEFAULTS.tunnelLength
    if (metresBetween(rc, p.at, at) <= length) return { index, from: p.at, to: advanceAt(rc, p.at, length), length }
  }
  return null
}

/** "Change the height here" on a road point: the Height tool, on that point's stretch. */
export function openHeightAtPoint(index: number): void {
  pickStretchAt('height', index)
}

/** "Make the stretch N m long": the same stretch, longer about its middle (so the Height slider can go higher). */
export function growStretch(from: number, to: number, metres: number): void {
  const d = useEditor.getState().draft
  const sel = resizeStretch(d, from, to, metres)
  useEditor.setState({ selection: { kind: 'section', ...sel } })
  say(`The stretch is ${Math.round(stretchMetres(d.points, sel.from, sel.to))} m long now. Working out how high it can go...`, 'info')
  audio.ui('select')
}

/**
 * The Height tool's "On the ground": the picked stretch goes back down onto the
 * ground (raise.ts groundDraft), built and checked first. One Undo step, and
 * the same stretch stays picked.
 */
export function groundStretch(from: number, to: number): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const id = s.savedId ?? draftId(s.draft)
  const t = getTrack()
  const o = raiseOptions() ?? { id, pointGround: pointGroundFor(s.draft), params: t && t.id === id ? { ...t.params } : {} }
  const res = groundDraft(s.draft, from, to, o)
  if (!res.ok || !res.draft) {
    say(res.reason ?? "Can't put that stretch back on the ground.", 'warn')
    audio.ui('error')
    return false
  }
  const next = res.draft
  commit((x) => {
    x.points = next.points
    x.pieces = next.pieces
    x.startAt = next.startAt
  })
  useEditor.setState({ selection: { kind: 'section', from: res.from ?? from, to: res.to ?? to } })
  say(res.done ?? 'Done.', res.limited ? 'warn' : 'good')
  audio.ui('select')
  return true
}

// ---------------------------------------------------------------- Smooth the bumps here (editor12)

/** What the last "Smooth the bumps here" did (or why it did nothing), on the draft it left and the stretch it left picked. */
export interface SmoothSaid {
  draft: Draft
  from: number
  to: number
  text: string
  tone: 'good' | 'warn' | 'info'
  /** True when the road changed (one Undo step). */
  changed: boolean
}

/**
 * The Height tool's "Smooth the bumps here": the picked stretch's road laid on
 * a smooth line through the ground under it (smooth.ts), built and checked
 * first. One Undo step, and the same stretch stays picked. Returns what it did
 * in words, for the panel (also said on the status line).
 */
export function smoothStretch(from: number, to: number): SmoothSaid | null {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return null
  const id = s.savedId ?? draftId(s.draft)
  const t = getTrack()
  const o = raiseOptions() ?? { id, pointGround: pointGroundFor(s.draft), params: t && t.id === id ? { ...t.params } : {} }
  const res = smoothDraft(s.draft, from, to, o)
  if (!res.ok || !res.draft) {
    const said: SmoothSaid = { draft: s.draft, from, to, text: res.reason ?? "Can't smooth that stretch.", tone: res.already ? 'info' : 'warn', changed: false }
    say(said.text, said.tone)
    audio.ui(res.already ? 'select' : 'error')
    return said
  }
  const next = res.draft
  commit((x) => {
    x.points = next.points
    x.pieces = next.pieces
    x.startAt = next.startAt
  })
  const sel = { from: res.from ?? from, to: res.to ?? to }
  useEditor.setState({ selection: { kind: 'section', ...sel } })
  const said: SmoothSaid = { draft: useEditor.getState().draft, ...sel, text: res.done ?? 'Smoothed.', tone: res.limited ? 'warn' : 'good', changed: true }
  say(said.text, said.tone)
  audio.ui('select')
  return said
}

// ---------------------------------------------------------------- the Height slider's ends, a build at a time

/** How a raise of this draft builds: the live preview's build and checks (it must be fresh), its id, ground and settings. */
function raiseOptions(): RaiseOptions | null {
  const s = useEditor.getState()
  const live = liveRuntime()
  if (!live || !s.gates) return null
  const id = s.savedId ?? draftId(s.draft)
  const t = getTrack()
  return { id, pointGround: pointGroundFor(s.draft), params: t && t.id === id ? { ...t.params } : {}, before: { runtime: live, gates: s.gates } }
}

/** Limits already worked out, per draft (a change makes a new draft, so they never go stale). */
const known = new WeakMap<Draft, Map<string, HeightLimits>>()
const keyOf = (from: number, to: number) => `${from.toFixed(4)}|${to.toFixed(4)}`
/** Stretches whose search threw (the panel says so instead of waiting for ever). */
const failed = new Set<string>()

/** The search in progress (only one at a time: the stretch on screen), and what it has checked so far. */
let job: { draft: Draft; key: string; steps: Generator<HeightLimits, HeightLimits, void>; sofar: HeightLimits | null } | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/** Tell the panel something changed (a step of the search, or the end of it). */
function changed(): void {
  for (const f of listeners) f()
}

/** The panel listens to the search. Returns the way to stop listening. */
export function onHeightLimits(f: () => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

/**
 * The Height slider's ends for the stretch from `from` to `to` on the draft as
 * it is now: worked out, or (`checking`) the heights checked so far, or null
 * before the first is checked. It starts the work (a build per tick, so the
 * editor never freezes) once the live preview has caught up.
 */
export function heightLimitsNow(from: number, to: number): HeightLimits | 'failed' | null {
  const d = useEditor.getState().draft
  const key = keyOf(from, to)
  const have = known.get(d)?.get(key)
  if (have) return have
  if (failed.has(key)) return 'failed'
  if (job && job.draft === d && job.key === key) return job.sofar
  const o = raiseOptions()
  if (!o) return null
  job = { draft: d, key, steps: heightLimitSteps(d, from, to, o), sofar: null }
  if (timer) clearTimeout(timer)
  // A short pause first: while a stretch is being dragged out, only the one he lets go of is worked out.
  timer = setTimeout(step, 120)
  return null
}

/** One build of the search in progress, then the next on a later tick. */
function step(): void {
  timer = null
  const j = job
  if (!j) return
  // The road changed under it (an edit, Undo): drop it; the panel asks again for the new road.
  if (useEditor.getState().draft !== j.draft) {
    job = null
    changed()
    return
  }
  let r: IteratorResult<HeightLimits, HeightLimits>
  try {
    r = j.steps.next()
  } catch (err) {
    // Say so (the panel shows it) rather than waiting for ever; a different stretch starts afresh.
    console.error('[editor] working out the Height slider failed', err)
    failed.add(`${j.key}`)
    job = null
    changed()
    return
  }
  if (!r.done) {
    // The heights checked so far: the slider can already offer them (every one builds).
    j.sofar = r.value
    changed()
    timer = setTimeout(step, 0)
    return
  }
  let map = known.get(j.draft)
  if (!map) known.set(j.draft, (map = new Map()))
  map.set(j.key, r.value)
  job = null
  changed()
}
