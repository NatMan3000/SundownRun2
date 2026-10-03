// ============================================================
//  TUNNEL PLACE - may this tunnel go here? Ask the real builder.
// ------------------------------------------------------------
//  Josh places a Tunnel (Place pieces) on a stretch of road, or
//  changes its Length. Whether it fits isn't something the editor
//  can guess: the game digs the road down for it on ramps about
//  190 m long, and that whole stretch must be clear road (no loop,
//  kicker, wall ride, start grid or other road). So the draft is
//  built with the tunnel by the real track builder (judge.ts), and
//  the change only lands if:
//
//    - the builder could build it (src/track/tunnels.ts says why
//      not, in plain words, if it couldn't), and
//    - no check that passed before fails now (the dip's lips, ...)
//
//  Otherwise it is refused, in plain words, and nothing changes.
//
//  Before any click (round C, Nathan: "there's nothing to tell me why I
//  can not put a tunnel somewhere and what it requires"):
//
//    quickTunnelCheck   asks only the builder's planner (the road's
//                       centre line, a few hundredths of a second, kept
//                       for repeats) whether a tunnel fits at a spot,
//                       how long each ramp is, and where whatever is in
//                       the way sits: the hover ghost and the Height
//                       panel show it, amber where it can't go
//    tunnelWhy          the reason in Josh's words ("the loop is in the
//                       way") and what to try
//    fitTunnelAt        a click that doesn't fit looks along the road
//                       (up to 500 m either way), then at shorter
//                       lengths, for the nearest tunnel that does, and
//                       places that, saying so ("Moved it 60 m along so
//                       it fits")
//
//  Pure: no editor state. draft.ts calls it; the self-tests too.
// ============================================================

import type { TrackRuntime } from '../track/types'
import { trackInternals } from '../track/build'
import { validateTrack } from '../track/validate'
import { tunnelPlanner } from '../track/road'
import { makeNaturalTerrain, type NaturalTerrain } from '../track/terrain'
import { TUNNEL_MAX_LENGTH, TUNNEL_MIN_LENGTH, type TunnelDigs, type TunnelRefusal, type TunnelWhere } from '../track/tunnels'
import { TRACK_DEFAULTS, type Piece, type ResolvedTrackFile } from '../track/schema'
import type { Draft } from './draft'
import { fileOfDraft } from './draftFile'
import { gateTitle, isGameBug, judgeDraft, newFailures, type Judged } from './judge'
import { advanceAt, roadCurve } from './road'
import { TUNNEL_EDIT_MIN, tunnelStartFor } from './pieces'

export type TunnelVerdict =
  | { ok: true; judged: Judged; depth: number; ramp: number; rampIn: number; rampOut: number; length: number }
  | { ok: false; message: string }

/**
 * Judge `next` (the draft with the tunnel at piece `index` added or changed) against `before`.
 * `id` and `params` are the draft's; `previous` a track built in the same world (its ground is
 * reused). `before` may be passed already judged (the live preview's checks). `tryInstead` ends a
 * refusal that a check caused: what Josh can do instead (a tunnel at a crossing can't be moved).
 */
export function judgeTunnel(
  before: Draft | Judged,
  next: Draft,
  index: number,
  id: string,
  params: Record<string, number>,
  previous?: TrackRuntime | null,
  tryInstead = 'Try it somewhere else, or make it shorter.',
): TunnelVerdict {
  const after = judgeDraft(next, id, params, previous)
  if (!after.runtime) return { ok: false, message: `Can't put a tunnel here: ${after.error ?? 'the track has a problem'}.` }
  const x = trackInternals(after.runtime)
  const plan = x?.tunnels.plans.find((p) => p.index === index)
  if (!plan) return { ok: false, message: "Can't put a tunnel here: the game couldn't plan it (a bug in the game, not your track)." }
  if (plan.problem) return { ok: false, message: `Can't put a tunnel here: ${plan.problem}.` }
  const was = 'gates' in before ? before : judgeDraft(before, id, params, previous ?? after.runtime)
  const broke = newFailures(was.gates, after.gates)
  // A check that only fails through the game's own fault (its fix line says "builder bug") gets honest words.
  const track = broke.find((g) => !isGameBug(g))
  if (broke.length && !track) return { ok: false, message: `Can't put a tunnel here: the game can't build it cleanly there yet (its ${broke[0].name} check fails, a bug in the game, not your track). Try it somewhere else.` }
  if (track) return { ok: false, message: `Can't put a tunnel here: with it, ${lowerFirst(gateTitle(track, next))} ${tryInstead}` }
  return { ok: true, judged: after, depth: plan.depth, ramp: plan.ramp, rampIn: plan.rampIn, rampOut: plan.rampOut, length: plan.sb1 - plan.sb0 }
}

/** "The road has a kink." -> "the road has a kink." (for the middle of a sentence). */
function lowerFirst(text: string): string {
  return text.length ? text[0].toLowerCase() + text.slice(1) : text
}

// ---------------------------------------------------------------- before the click

/** What the planner says about a tunnel at one spot (quickTunnelCheck). */
export interface QuickTunnel {
  ok: boolean
  /** Why not, as data (null when it fits, or when the file itself wouldn't load: then `error`). */
  refusal: TunnelRefusal | null
  error?: string
  /** Each ramp's length (metres) and how deep it digs: the footprint the map draws (0 when unknown). */
  rampIn: number
  rampOut: number
  depth: number
}

const natCache = new Map<string, NaturalTerrain>()

/**
 * One road's tunnel planner (road.ts tunnelPlanner) with the answers it has given: the draft's file is
 * validated and its centre line worked out once, then each question costs only the planner.
 */
interface PlanBase {
  file: ResolvedTrackFile | null
  error: string | null
  plan: ((pieces: ResolvedTrackFile['pieces']) => TunnelDigs) | null
  answers: Map<string, QuickTunnel>
}
/**
 * Per road (the points array, by identity) and then by everything else in the track file and the live
 * settings: two drafts that share their points but differ in anything else (the world, the road's
 * width or surface, the start line, a piece) never share an answer.
 */
const planBases = new WeakMap<Draft['points'], Map<string, PlanBase>>()

function planBaseFor(d: Draft, id: string, params: Record<string, number>): PlanBase {
  const f = fileOfDraft(d, id)
  const key = JSON.stringify({ ...f, road: { ...f.road, points: null } }) + JSON.stringify(params)
  let byFile = planBases.get(d.points)
  if (!byFile) {
    byFile = new Map()
    planBases.set(d.points, byFile)
  }
  const known = byFile.get(key)
  if (known) return known
  let base: PlanBase
  const v = validateTrack(f)
  if (!v.ok || !v.track) base = { file: null, error: v.errors[0]?.message ?? 'the track has a problem', plan: null, answers: new Map() }
  else {
    const file = v.track
    const envKey = JSON.stringify(file.environment)
    let nat = natCache.get(envKey)
    if (!nat) {
      nat = makeNaturalTerrain(file.environment)
      if (natCache.size > 8) natCache.clear()
      natCache.set(envKey, nat)
    }
    const banking = file.road.banking
    const bank = banking.adjustable && typeof params.bankDeg === 'number' ? params.bankDeg : banking.maxDeg
    try {
      base = { file, error: null, plan: tunnelPlanner(file, bank, nat), answers: new Map() }
    } catch (err) {
      base = { file, error: (err as Error).message, plan: null, answers: new Map() }
    }
  }
  if (byFile.size > 16) byFile.clear()
  byFile.set(key, base)
  return base
}

/**
 * Would a tunnel `length` metres long starting at `at` fit on draft `d`? Asks the track builder's
 * planner only (src/track/tunnels.ts, on the road's centre line: no ground, meshes or checks), so it
 * is quick enough to answer while the pointer moves, and for every spot a click's fit looks at. The
 * answer depends only on the draft, the spot and the settings, never on what was asked before. The
 * checks still have the last word when it is placed (judgeTunnel). `existing`: the index of a tunnel
 * the draft already has, to ask about it instead of adding one.
 */
export function quickTunnelCheck(d: Draft, at: number, length: number, id: string, params: Record<string, number> = {}, existing?: number): QuickTunnel {
  const fresh = existing === undefined
  // A spot or length the file itself wouldn't take: the validator's words, the slow way.
  if (fresh && (!(at >= 0 && at < d.points.length) || !(length >= TUNNEL_MIN_LENGTH && length <= TUNNEL_MAX_LENGTH))) {
    const v = validateTrack(fileOfDraft({ ...d, pieces: [...d.pieces, { type: 'tunnel', at, length } as Piece] }, id))
    return { ok: false, refusal: null, error: v.errors[0]?.message ?? 'the track has a problem', rampIn: 0, rampOut: 0, depth: 0 }
  }
  const base = planBaseFor(d, id, params)
  const key = `${existing ?? 'new'}|${at.toFixed(3)}|${length}`
  const known = base.answers.get(key)
  if (known) return known
  let out: QuickTunnel
  if (!base.file || !base.plan) out = { ok: false, refusal: null, error: base.error ?? 'the track has a problem', rampIn: 0, rampOut: 0, depth: 0 }
  else {
    // The piece as the validator resolves it (a tunnel's at and length pass through as they are).
    const pieces = fresh ? [...base.file.pieces, { type: 'tunnel' as const, at, length }] : base.file.pieces
    const index = existing ?? pieces.length - 1
    try {
      const plan = base.plan(pieces).plans.find((pl) => pl.index === index)
      out = plan
        ? { ok: !plan.problem, refusal: plan.refusal, rampIn: plan.rampIn, rampOut: plan.rampOut, depth: plan.depth }
        : { ok: false, refusal: null, error: "the game couldn't plan it", rampIn: 0, rampOut: 0, depth: 0 }
    } catch (err) {
      out = { ok: false, refusal: null, error: (err as Error).message, rampIn: 0, rampOut: 0, depth: 0 }
    }
  }
  if (base.answers.size > 2000) base.answers.clear()
  base.answers.set(key, out)
  return out
}

/** The things a tunnel can't share road with, in Josh's words. */
const THING_WORDS: Record<string, string> = {
  loop: 'the loop is in the way',
  ramp: 'the jump ramp (and the road it throws you onto) is in the way',
  wallride: 'the wall ride is in the way',
  grid: 'the start line is in the way: the cars line up there on flat road',
  tunnel: 'another tunnel is in the way',
}

/**
 * Why a tunnel can't go there, and what to try, in Josh's words (never a piece number). `need` is
 * how much road it needs: its ramps down and up plus the covered part.
 */
export function tunnelWhy(q: QuickTunnel, length: number): { why: string; tryThis: string; hint: string } {
  const w = tunnelWhyLong(q, length)
  return { ...w, hint: tunnelHint(q) }
}

/** What to try, in a few words (the map's pill by the mouse). */
function tunnelHint(q: QuickTunnel): string {
  const r = q.refusal
  if (!r) return 'try somewhere else'
  if (r.kind === 'inTheWay') return 'try further along, away from it, or make it shorter'
  if (r.kind === 'roadNear') return r.over ? 'make it longer, or try further along' : 'try further along, away from the other road'
  if (r.kind === 'barriers') return 'tunnels need a track without barriers'
  if (r.kind === 'tooHigh') return 'put it where the road is on the ground'
  if (r.kind === 'tooShort') return 'make it shorter'
  return 'move one of them'
}

function tunnelWhyLong(q: QuickTunnel, length: number): { why: string; tryThis: string } {
  const r = q.refusal
  const need = Math.round(q.rampIn + length + q.rampOut)
  const needs = q.rampIn > 0 ? ` A ${Math.round(length)} m tunnel needs ${need} m of plain road: a ${Math.round(q.rampIn)} m ramp down, the covered part, and a ${Math.round(q.rampOut)} m ramp up.` : ''
  if (!r) return { why: q.error ?? "the game couldn't plan it", tryThis: 'Try somewhere else.' }
  switch (r.kind) {
    case 'inTheWay':
      return { why: THING_WORDS[r.thing] ?? 'something is in the way', tryThis: `Try further along the road, away from it, or make it shorter.${needs}` }
    case 'roadNear':
      return r.over
        ? { why: "the other road runs too close beside the tunnel's ramps, where the road dips down", tryThis: `Make it longer, so the other road only crosses over its roof, or try further along.${needs}` }
        : { why: 'another bit of road runs right beside where this one dips down', tryThis: `Try further along, away from the other road.${needs}` }
    case 'barriers':
      return { why: "this track has barriers along its road, and a tunnel's walls would stand where they are", tryThis: 'Tunnels only go on tracks without barriers.' }
    case 'tooHigh':
      return r.over
        ? { why: 'the road crossing over it is too high above the ground here', tryThis: 'Bring that road down to the ground first (the Height tool), or put the tunnel where it runs on the ground.' }
        : { why: `the road is too high above the ground here (it would have to dig ${Math.round(r.dig)} m down)`, tryThis: 'Put it where the road runs on the ground, or through a hill, or bring the road down first.' }
    case 'tooShort':
      return { why: `the whole road is too short for a tunnel this long with its ramps (it needs ${Math.round(r.needs)} m)`, tryThis: 'Make it shorter.' }
    case 'underTunnel':
      return { why: 'the road over it is already in a tunnel of its own', tryThis: 'Move one of them.' }
  }
}

/** Where on the road the thing in a tunnel's way is (for the map's amber mark), if the planner said. */
export function tunnelBlocker(q: QuickTunnel): TunnelWhere | null {
  const r = q.refusal
  return r && (r.kind === 'inTheWay' || r.kind === 'roadNear') ? r.where : null
}

/** A tunnel found by fitTunnelAt: the piece, how far it moved from where it was asked for, and what it does. */
export type TunnelFit =
  | { ok: true; piece: Piece & { type: 'tunnel' }; moved: number; length: number; asked: number; verdict: Extract<TunnelVerdict, { ok: true }> }
  | { ok: false; message: string }

/** How far along the road (metres, either way) a click may move to fit, and the step it looks in. */
const FIT_REACH = 500
const FIT_STEP = 20
/** Shorter lengths a click may fall back to, metres (never below TUNNEL_EDIT_MIN). */
const FIT_LENGTHS = [120, 90, 60, TUNNEL_EDIT_MIN]
/**
 * At most this many full builds while looking (each candidate first passes quickTunnelCheck). A count,
 * never a time: the same road and click give the same tunnel on any computer, however busy (round D:
 * with a 3 s budget, a click by the start line came out differently on a slow page).
 */
const FIT_JUDGES = 8

/** What the last fit did (__dev.editor('lastFit')): how many spots it asked the planner about, how many it built, and how long it took. */
export interface TunnelFitTrace {
  quick: number
  judged: number
  ms: number
  refusedByChecks: string[]
}
let lastFit: TunnelFitTrace | null = null
export function lastTunnelFit(): TunnelFitTrace | null {
  return lastFit
}

/**
 * A tunnel `length` metres long with its middle at `middle` (an `at`) on draft `d`, or the nearest
 * one that fits: the same length up to FIT_REACH metres along the road either way, then shorter
 * ones, nearest first. Each candidate is asked of the planner (quickTunnelCheck) and the first that
 * fits is judged for real (judgeTunnel: built, no check that passed starts failing). `before`: the
 * checks as they are now, if known.
 */
export function fitTunnelAt(d: Draft, middle: number, length: number, id: string, params: Record<string, number>, previous?: TrackRuntime | null, before?: Judged): TunnelFit {
  const rc = roadCurve(d.points)
  const index = d.pieces.length
  const offsets = [0]
  for (let m = FIT_STEP; m <= FIT_REACH; m += FIT_STEP) offsets.push(m, -m)
  const lengths = [length, ...FIT_LENGTHS.filter((l) => l < length)]
  let judged: Judged | Draft = before ?? d
  let judges = 0
  let firstWords = ''
  const asked = quickTunnelCheck(d, tunnelStartFor(rc, middle, length), length, id, params)
  // Nothing on this track can take a tunnel: say so straight away.
  if (asked.refusal?.kind === 'barriers') {
    const w = tunnelWhy(asked, length)
    return { ok: false, message: `Can't put a tunnel here: ${w.why}. ${w.tryThis}` }
  }
  // Nearest first: each metre moved costs as much as a metre and a half of tunnel lost. (A stable sort
  // on a fixed list: ties always go the same way.)
  const candidates: { off: number; len: number; cost: number }[] = []
  for (const len of lengths) for (const off of offsets) candidates.push({ off, len, cost: Math.abs(off) + 1.5 * (length - len) })
  candidates.sort((a, b) => a.cost - b.cost)
  const trace: TunnelFitTrace = { quick: 0, judged: 0, ms: 0, refusedByChecks: [] }
  lastFit = trace
  const t0 = performance.now()
  const done = <T,>(out: T): T => {
    trace.ms = Math.round(performance.now() - t0)
    return out
  }
  for (const { off, len } of candidates) {
    const at = tunnelStartFor(rc, advanceAt(rc, middle, off), len)
    const q = quickTunnelCheck(d, at, len, id, params)
    trace.quick++
    if (!q.ok) continue
    const piece: Piece & { type: 'tunnel' } = { type: 'tunnel', at }
    if (len !== TRACK_DEFAULTS.tunnelLength) piece.length = len
    const next: Draft = { ...d, pieces: [...d.pieces, piece] }
    const v = judgeTunnel(judged, next, index, id, params, previous)
    judges++
    trace.judged = judges
    if (!('gates' in judged)) judged = judgeDraft(d, id, params, previous)
    if (v.ok) return done({ ok: true, piece, moved: off, length: len, asked: length, verdict: v })
    trace.refusedByChecks.push(`${off} m, ${len} m: ${v.message.slice(0, 120)}`)
    firstWords ||= v.message
    if (judges >= FIT_JUDGES) break
  }
  const w = tunnelWhy(asked, length)
  if (!asked.ok) return done({ ok: false, message: `Can't put a tunnel here: ${w.why}. There's no room for one within ${FIT_REACH} m of here either. ${w.tryThis}` })
  return done({ ok: false, message: firstWords || `Can't put a tunnel here: there's no room for one within ${FIT_REACH} m of here.` })
}

/** What a fitted tunnel's click did, in Josh's words: where it went if it moved, and its length if shorter. */
export function fitWords(f: Extract<TunnelFit, { ok: true }>): string {
  const parts: string[] = []
  if (Math.abs(f.moved) >= 1) parts.push(`Moved it ${Math.abs(Math.round(f.moved))} m ${f.moved > 0 ? 'further along' : 'back'} so it fits.`)
  if (f.length < f.asked) parts.push(`Made it ${f.length} m long so it fits.`)
  return parts.join(' ')
}

/** What a placed tunnel does, in Josh's words. */
export function tunnelWords(v: { depth: number; ramp: number; rampIn?: number; rampOut?: number; length: number }): string {
  const rin = Math.round(v.rampIn ?? v.ramp)
  const rout = Math.round(v.rampOut ?? v.ramp)
  const ramps = rin === rout ? `${rin} m ramps either side` : `a ${rin} m ramp down and a ${rout} m ramp up`
  return `the road dips ${v.depth.toFixed(1)} m into the ground on ${ramps}, and the hill goes back over ${Math.round(v.length)} m of it`
}
