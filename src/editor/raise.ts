// ============================================================
//  RAISE - lift (or lower) a whole stretch of road on smooth ramps
// ------------------------------------------------------------
//  Josh picks a stretch of road (the Stretch tool) and sets how high
//  its MIDDLE sits above the ground. The road then rises smoothly
//  from each end of the stretch to the middle and back down, in the
//  same smooth shape as the clean-up's bridge ramps (half a cosine
//  wave each side), so there is no kink where it leaves the ground.
//
//  Drivable means two things:
//    1. The game's own checks still pass (crest, smooth, banking,
//       under, bridges, surface...): the raised road is built with the
//       real track builder and judged before it lands (judge.ts).
//    2. A car doesn't take off over the top. Over a crest the road
//       falls away from the car; at speed v over a crest of radius R
//       the car needs v^2 / R of pull to stay on, and gravity gives
//       at most g. The game's own crest check allows 80% of gravity
//       (CREST_LIMIT), at the fastest a car is likely to be there (the
//       racing line's speed plus 15%, up to 250 km/h): the same rule,
//       so a hill is judged like a bank roll.
//
//  The half-cosine bump over a stretch L metres long, H metres high,
//  is curved most at the top: H x 2 pi^2 / L^2. So the most a stretch
//  can rise for a speed v is  H = share x g x L^2 / (2 pi^2 v^2)
//  (mostRise). If Josh asks for more, the middle goes as high as is
//  safe and the status line says how long a stretch he would need.
//
//  Like bridges.ts: the whole road first gets close, even points (the
//  road does not move), only the stretch's heights change, a point
//  keeps its own kind of height (a `y` stays a `y`, a `lift` a `lift`),
//  and a bridge over or under the stretch keeps room for a car.
//
//  Pure: points in, points out. Checked by selfTestFixes.ts.
// ============================================================

import { CREST_CHECK_KMH, CREST_LIMIT } from '../track/bankRolls'
import { trackInternals } from '../track/build'
import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import type { TrackGate } from '../track/gates'
import { SURFACE_CODE, type NearestHit, type TrackRuntime } from '../track/types'
import { CLEANUP } from './cleanup'
import type { Draft } from './draft'
import { BRIDGE_GAP, type GroundFn, roadCrossings } from './bridges'
import { LOOP_RUN_IN, wrapAt } from './road'
import { atOf, densify, pointHeight, posOf, roadHeightAt, roadLine, sOf, sOfPoint, wrapS, type RoadLine } from './shape'
import { gateTitle, isGameBug, judgeDraft, newFailures } from './judge'

/** The highest a stretch's middle can go above the ground, metres (the same as the point slider: no road into the sky). */
export const RAISE_MAX = 16
/** The shortest stretch that can be raised, metres. */
export const RAISE_MIN_METRES = 30
/** The planned bump asks at most this share of gravity's pull at its top; the built road is judged at CREST_LIMIT (80%). */
const PLAN_SHARE = 0.65
const G = 9.81
const FLAT: GroundFn = () => 0

// ---------------------------------------------------------------- how high a stretch can go

/** The most a bump `metres` long can rise (metres) before a car at `v` m/s goes light over its top. */
export function mostRise(metres: number, v: number): number {
  return (PLAN_SHARE * G * metres * metres) / (2 * Math.PI * Math.PI * v * v)
}

/** How long a stretch must be (metres) to rise `rise` metres for a car at `v` m/s. */
export function stretchFor(rise: number, v: number): number {
  return Math.sqrt((2 * Math.PI * Math.PI * Math.abs(rise) * v * v) / (PLAN_SHARE * G))
}

/** The fastest a car is likely to be on a road with no hill: the crest checks' own speed cap (250 km/h). */
export const TOP_SPEED = CREST_CHECK_KMH / 3.6

/**
 * The samples of a built road that belong to the stretch from `from` to `to`
 * (`at` values on the draft it was built from, `count` points), plus `margin`
 * metres either side. In driving order.
 */
export function stretchSamples(t: TrackRuntime, from: number, to: number, count: number, margin = 0): number[] {
  const x = trackInternals(t)
  if (!x) return []
  const S = t.samples
  const span = wrapAt(to - from, count)
  const inside = new Uint8Array(S.count)
  let any = -1
  for (let i = 0; i < S.count; i++) {
    if (wrapAt(x.atOfS(i * S.ds) - from, count) <= span) {
      inside[i] = 1
      any = i
    }
  }
  if (any < 0) return []
  // Walk back to where the run starts, then forward over it, plus the margin both ways.
  let start = any
  for (let k = 0; k < S.count && inside[(start - 1 + S.count) % S.count]; k++) start = (start - 1 + S.count) % S.count
  let len = 0
  while (len < S.count && inside[(start + len) % S.count]) len++
  const m = Math.round(margin / S.ds)
  const out: number[] = []
  for (let k = -m; k < len + m && out.length < S.count; k++) out.push((((start + k) % S.count) + S.count) % S.count)
  return out
}

/**
 * How fast a car is likely to be on a stretch, m/s: the racing line's plan
 * there plus 15% (a later brake, a boost), up to 250 km/h. The same rule as
 * the game's crest check. Without a built road, 250 km/h.
 */
export function stretchSpeed(t: TrackRuntime | null, points: readonly RoadPoint[], from: number, to: number): number {
  if (!t) return TOP_SPEED
  const idx = stretchSamples(t, from, to, points.length, 30)
  if (!idx.length) return TOP_SPEED
  let v = 0
  for (const i of idx) v = Math.max(v, t.racingLine.speed[i])
  return Math.min(TOP_SPEED, v * 1.15)
}

/**
 * How far either way the launch check looks along a raised stretch `metres`
 * long: an eighth of it, 6 to 20 m. Long enough that ripples in the ground a
 * few metres long (a car's springs soak those up) don't count, short enough
 * to see the top of the hill (90% of its true sharpness).
 */
export function launchHalf(metres: number): number {
  return Math.max(6, Math.min(20, metres / 8))
}

/**
 * Over the samples `idx` of a built road: the most of gravity's pull a car at
 * `v` m/s needs to stay on where the road crests (1 = it just floats; over
 * CREST_LIMIT it goes light). Measured like the racing line measures crests,
 * from the change of slope over 2 x `half` metres (see launchHalf).
 */
export function launchShare(t: TrackRuntime, idx: readonly number[], v: number, half = 6): { worst: number; s: number } {
  let worst = 0
  let s = idx.length ? idx[0] * t.samples.ds : 0
  for (const i of idx) {
    const share = shareAt(t, i, v, half)
    if (share > worst) {
      worst = share
      s = i * t.samples.ds
    }
  }
  return { worst, s }
}

/** launchShare for one sample (0 where the road dips or isn't plain road). */
function shareAt(t: TrackRuntime, i: number, v: number, half: number): number {
  const S = t.samples
  const W = Math.max(1, Math.round(half / S.ds))
  const a = (i - W + S.count) % S.count
  const b = (i + W) % S.count
  if (S.surface[a] !== SURFACE_CODE.road || S.surface[i] !== SURFACE_CODE.road || S.surface[b] !== SURFACE_CODE.road) return 0
  const ga = S.ty[a] / (Math.hypot(S.tx[a], S.tz[a]) || 1)
  const gb = S.ty[b] / (Math.hypot(S.tx[b], S.tz[b]) || 1)
  const crest = -(gb - ga) / (2 * W * S.ds)
  if (crest <= 0 || S.uy[i] <= 0) return 0
  return (v * v * crest) / (G * S.uy[i])
}

/**
 * Does a changed road launch a car anywhere the old one didn't? Spot by spot
 * over the samples `idx` of the new road: the share of gravity a car at `v`
 * needs there may be up to CREST_LIMIT, or, where the old road at the same
 * spot already asked more (a lumpy hill the stretch starts on), no more than
 * it did. Returns the worst spot, and by how much it goes over (<= 0: fine).
 */
export function launchOver(after: TrackRuntime, before: TrackRuntime | null, idx: readonly number[], v: number, half: number): { worst: number; over: number; s: number } {
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const S = after.samples
  let worst = 0
  let over = -Infinity
  let s = idx.length ? idx[0] * S.ds : 0
  for (const i of idx) {
    const share = shareAt(after, i, v, half)
    let was = 0
    if (before) {
      before.nearest(S.px[i], S.py[i], S.pz[i], hit, i * S.ds)
      was = shareAt(before, hit.index, v, half)
    }
    const by = share - Math.max(CREST_LIMIT, was + 0.02)
    if (share > worst) worst = share
    if (by > over) {
      over = by
      s = i * S.ds
    }
  }
  return { worst, over: idx.length ? over : 0, s }
}

// ---------------------------------------------------------------- the stretch as it is now

/** A stretch of road measured on the draft: its length, and how high it sits above the ground at its ends and middle. */
export interface StretchNow {
  metres: number
  /** Height above the ground at the two ends, averaged (the bump rises from here). */
  ends: number
  /** Height above the ground at the middle now. */
  middle: number
}

/** The road's height above the ground at `at` (as the game builds it). */
export function liftAt(line: RoadLine, at: number, ground: GroundFn): number {
  const p = posOf(line, sOf(line, at))
  return roadHeightAt(line.points, at, ground) - ground(p.x, p.z)
}

export function stretchNow(points: readonly RoadPoint[], from: number, to: number, ground: GroundFn = FLAT): StretchNow {
  const line = roadLine(points)
  const s0 = sOf(line, from)
  const metres = wrapS(sOf(line, to) - s0, line.length)
  return {
    metres,
    ends: (liftAt(line, from, ground) + liftAt(line, to, ground)) / 2,
    middle: liftAt(line, atOf(line, s0 + metres / 2), ground),
  }
}

/** The lowest and highest the middle of a stretch can go, metres above the ground, for a car at `v` m/s. */
export function heightRange(now: StretchNow, v: number): { lo: number; hi: number; most: number } {
  const most = mostRise(now.metres, v)
  return { lo: Math.max(0, now.middle - most), hi: Math.min(RAISE_MAX, now.middle + most), most }
}

// ---------------------------------------------------------------- the new heights

export interface RaiseInput {
  points: readonly RoadPoint[]
  pieces: readonly Piece[]
  startAt: number
  /** Road width, metres. */
  width: number
  /** The ground under road points (exact, from the draft's world); without it, flat ground. */
  pointGround?: GroundFn
}

export interface RaisePlan {
  ok: boolean
  /** Why not: 'short' (the stretch), 'pieces' (a loop, ramp or wall ride, or the start grid), 'bridge' (a bridge would be squashed). */
  why?: 'short' | 'pieces' | 'bridge'
  reason?: string
  points: RoadPoint[]
  /** Old `at` to new `at`. */
  mapAt: (at: number) => number
}

function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

/** How much of the bump a spot `u` of the way along the stretch gets: 0 at the ends, 1 in the middle, smooth all the way. */
export function bumpWeight(u: number): number {
  if (u <= 0 || u >= 1) return 0
  const s = Math.sin(Math.PI * u)
  return s * s
}

const PIECE_WORDS: Partial<Record<Piece['type'], string>> = { loop: 'loop', ramp: 'ramp', wallride: 'wall ride' }

/** "the 420 m mark" / "the 1.16 km mark": a spot on the road, by how far it is after the start line. */
export function markWords(line: RoadLine, startAt: number, at: number): string {
  const m = Math.round(wrapS(sOf(line, at) - sOf(line, startAt), line.length))
  return m >= 1000 ? `the ${(m / 1000).toFixed(2)} km mark` : `the ${m} m mark`
}

/**
 * The road with the middle of the stretch from `from` to `to` at `height`
 * metres above the ground, rising smoothly from the stretch's ends. Only the
 * shape is worked out here; raiseDraft builds it and judges it.
 */
export function planRaise(input: RaiseInput, from: number, to: number, height: number): RaisePlan {
  const ground = input.pointGround ?? FLAT
  const original = input.points
  const refuse = (why: RaisePlan['why'], reason: string): RaisePlan => ({ ok: false, why, reason, points: original.map((p) => ({ ...p })), mapAt: (at) => at })
  const line0 = roadLine(original)
  const span = wrapS(sOf(line0, to) - sOf(line0, from), line0.length)
  if (span < RAISE_MIN_METRES) return refuse('short', `That stretch is only ${Math.round(span)} m long. Pick at least ${RAISE_MIN_METRES} m of road to raise.`)
  if (span > line0.length - 60) return refuse('short', 'That is nearly the whole road. Pick a shorter stretch: the road has to come back down somewhere.')

  // Close, even points all round (what bridges.ts does), so the bump has points to shape.
  const even = densify(line0, 0, line0.length, 20, CLEANUP.spacing, { pointGround: input.pointGround })
  const pts = even.points
  const line = roadLine(pts)
  const L = line.length
  const t0 = sOf(line, even.mapAt(from))
  const len = wrapS(sOf(line, even.mapAt(to)) - t0, L)
  // The road eases from where it is now toward a straight line between the stretch's two
  // ends, lifted (or lowered) so the middle lands `height` above the ground. In the middle
  // it IS that line, so the ground's own little ripples (and any steep old ramps) are gone
  // from the top, and the only bend left there is the ease itself, which mostRise keeps
  // gentle enough to drive. At the ends the ease is flat, so the road leaves the old one
  // with no kink.
  const y0 = roadHeightAt(original, from, ground)
  const y1 = roadHeightAt(original, to, ground)
  const mid = posOf(line, t0 + len / 2)
  const lift0 = ground(mid.x, mid.z) + height - (y0 + y1) / 2
  const next = pts.map((p, k) => {
    const d = wrapS(sOfPoint(line, k) - t0, L)
    const u = d / len
    const w = bumpWeight(u)
    if (w <= 0) return p
    const g = ground(p.x, p.z)
    const was = pointHeight(p, ground)
    const toward = y0 + (y1 - y0) * u + lift0
    const lift = was + (toward - was) * w - g
    const old = was - g
    if (Math.abs(lift - old) < 0.005) return p
    const out: RoadPoint = { ...p }
    if (typeof p.y === 'number') out.y = roundCm(g + lift)
    else {
      const l = Math.max(-30, roundCm(lift))
      if (l === 0) delete out.lift
      else out.lift = l
    }
    return out
  })

  // How much the road's height changes at a spot on the OLD road.
  const change = (atOld: number) => roadHeightAt(next, even.mapAt(atOld), ground) - roadHeightAt(original, atOld, ground)
  const changeAlong = (atOld: number, a: number, b: number) => {
    const s0 = sOf(line0, atOld)
    let worst = 0
    for (let d = a; d <= b; d += 5) worst = Math.max(worst, Math.abs(change(atOf(line0, s0 + d))))
    return worst
  }

  // Bridges: one that has room for a car keeps it (and keeps the same road on top).
  for (const c of roadCrossings(original, ground)) {
    if (c.over === null || c.gap < BRIDGE_GAP) continue
    const dh = [change(c.passes[0].at), change(c.passes[1].at)]
    if (Math.abs(dh[0]) < 0.05 && Math.abs(dh[1]) < 0.05) continue
    const h0 = c.passes[0].height + dh[0]
    const h1 = c.passes[1].height + dh[1]
    const top = c.over
    const gap = top === 0 ? h0 - h1 : h1 - h0
    if (gap >= BRIDGE_GAP + 0.3) continue
    const other = markWords(line0, input.startAt, c.passes[top === 0 ? 1 : 0].at)
    const upper = markWords(line0, input.startAt, c.passes[top].at)
    const room = Math.max(0, gap)
    // Which road of the bridge is in this stretch?
    const movedTop = Math.abs(dh[top]) >= Math.abs(dh[top === 0 ? 1 : 0])
    return refuse(
      'bridge',
      movedTop
        ? `This stretch is a bridge over the road at ${other}, and that low it would leave only ${room.toFixed(1)} m between them (a car needs ${BRIDGE_GAP} m). Keep the middle higher, or pick a stretch that stops before the bridge.`
        : `This stretch goes under the bridge at ${upper}, and that high it would leave only ${room.toFixed(1)} m between them (a car needs ${BRIDGE_GAP} m). Keep it lower, or pick a stretch that stops before the bridge.`,
    )
  }

  // Pieces that need their road as it is: loops, ramps and wall rides, and the start grid.
  for (const piece of input.pieces) {
    const word = PIECE_WORDS[piece.type]
    if (!word) continue
    const spanOf =
      piece.type === 'loop'
        ? [-(LOOP_RUN_IN + 10), LOOP_RUN_IN + 5 * (piece.radius ?? TRACK_DEFAULTS.loopRadius)]
        : piece.type === 'wallride'
          ? [0, piece.length ?? TRACK_DEFAULTS.wallride.length]
          : [-30, 30]
    if (changeAlong(piece.at, spanOf[0], spanOf[1]) > 0.3) {
      return refuse('pieces', `A ${word} is on this stretch (at ${markWords(line0, input.startAt, piece.at)}): the road under it would tip up or down. Move the ${word} off it first, or pick a stretch without it.`)
    }
  }
  if (changeAlong(input.startAt, -70, 25) > 0.3) {
    return refuse('pieces', 'The start line is on this stretch: the cars on the grid need level road. Pick a stretch that stops 70 m before the start line, or move the start line (Place pieces, Start line).')
  }
  return { ok: true, points: next, mapAt: even.mapAt }
}

// ---------------------------------------------------------------- building it for real

export interface RaiseOptions {
  /** The id the draft builds under (its world's hills come from it when it has no seed). */
  id: string
  pointGround?: GroundFn
  /** Live track parameters (a bank slider), as the preview builds with. */
  params?: Record<string, number>
  /** The draft as it is now, already built and checked (the live preview), if it is fresh. */
  before?: { runtime: TrackRuntime | null; gates: readonly TrackGate[] }
}

export interface RaiseResult {
  ok: boolean
  draft?: Draft
  /** Why not, in plain words. */
  reason?: string
  /** What happened, in plain words. */
  done?: string
  /** The height the middle got, metres above the ground. */
  height?: number
  /** True when it went less far than asked (too short a stretch, or a check said no higher). */
  limited?: boolean
  /** The stretch on the new road (for keeping it selected). */
  from?: number
  to?: number
}

/** "8 m", "2.5 m": a height in words. */
function metresWords(v: number): string {
  const r = Math.round(v * 10) / 10
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} m`
}

/**
 * Set the middle of the stretch from `from` to `to` to `wanted` metres above
 * the ground. Built with the real builder and judged by the game's checks
 * (nothing that passed may fail) and the launch rule (a car stays on over the
 * top). If the stretch is too short for that height, the middle goes as high
 * as is safe and `done` says so. Never changes `d`.
 */
export function raiseDraft(d: Draft, from: number, to: number, wanted: number, o: RaiseOptions): RaiseResult {
  const ground = o.pointGround ?? FLAT
  const before = o.before ?? (() => {
    const j = judgeDraft(d, o.id, o.params)
    return { runtime: j.runtime, gates: j.gates }
  })()
  const v = stretchSpeed(before.runtime, d.points, from, to)
  const kmh = Math.round((v * 3.6) / 10) * 10
  const now = stretchNow(d.points, from, to, ground)
  if (now.metres < RAISE_MIN_METRES) return { ok: false, reason: `That stretch is only ${Math.round(now.metres)} m long. Pick at least ${RAISE_MIN_METRES} m of road to raise.` }
  const want = Math.max(0, Math.min(RAISE_MAX, wanted))
  const range = heightRange(now, v)
  const target = Math.max(range.lo, Math.min(range.hi, want))
  const tooShort = Math.abs(target - want) > 0.05
  if (Math.abs(target - now.middle) < 0.05) {
    if (tooShort) {
      const need = Math.ceil(stretchFor(want - now.middle, v) / 10) * 10
      return { ok: false, reason: `This stretch is ${Math.round(now.metres)} m long, so its middle can't go any ${want > now.middle ? 'higher' : 'lower'} without a car at ${kmh} km/h taking off over the top. Select about ${need} m of road to go to ${metresWords(want)}.` }
    }
    return { ok: false, reason: `The middle of that stretch is already ${metresWords(now.middle)} above the ground.` }
  }
  const half = launchHalf(now.metres)

  /** Build the stretch at height h and judge it: the new draft, or why not. */
  const attempt = (h: number): { ok: true; draft: Draft; from: number; to: number } | { ok: false; stop?: boolean; reason: string } => {
    const plan = planRaise({ points: d.points, pieces: d.pieces, startAt: d.startAt, width: d.width, pointGround: o.pointGround }, from, to, h)
    // A piece or the start grid in the way: no height fixes that.
    if (!plan.ok) return { ok: false, stop: plan.why !== 'bridge', reason: plan.reason ?? '' }
    const next: Draft = {
      ...d,
      points: plan.points,
      pieces: d.pieces.map((p) => ({ ...p, at: Math.round(plan.mapAt(p.at) * 1000) / 1000 })),
      startAt: Math.round(plan.mapAt(d.startAt) * 1000) / 1000,
    }
    const newFrom = plan.mapAt(from)
    const newTo = plan.mapAt(to)
    const after = judgeDraft(next, o.id, o.params, before.runtime)
    if (!after.runtime) return { ok: false, reason: `the game couldn't build the road that way (${after.error}).` }
    const fresh = newFailures(before.gates, after.gates)
    if (fresh.length) {
      const g = fresh.find((x) => !isGameBug(x)) ?? fresh[0]
      return { ok: false, reason: isGameBug(g) ? `the game can't build it cleanly that far (${gateTitle(g, next)} That's the game's fault, not your track.)` : lowerFirst(gateTitle(g, next)) }
    }
    // A road that already had a lumpy crest there may keep it, but nowhere may the change make a car lighter than that.
    const launch = launchOver(after.runtime, before.runtime, stretchSamples(after.runtime, newFrom, newTo, next.points.length, 30), v, half)
    if (launch.over > 0) return { ok: false, reason: `a car at ${kmh} km/h would take off over the top.` }
    return { ok: true, draft: next, from: newFrom, to: newTo }
  }

  // The height asked for (as far as the stretch's length allows) first. If the game says no,
  // halve the way back toward where the middle is now, five times, keeping the best that works.
  let best = attempt(target)
  let bestH = target
  let why = ''
  if (!best.ok) {
    if (best.stop) return { ok: false, reason: `${best.reason} Nothing changed.` }
    why = best.reason
    let good = now.middle
    let bad = target
    for (let k = 0; k < 5; k++) {
      const h = Math.round(((good + bad) / 2) * 10) / 10
      if (Math.abs(h - now.middle) < 0.1 || Math.abs(h - bad) < 0.05) break
      const r = attempt(h)
      if (r.ok) {
        best = r
        bestH = h
        good = h
      } else bad = h
    }
  }
  if (!best.ok) {
    const way = target > now.middle ? 'higher' : 'lower'
    return { ok: false, reason: `Can't make that stretch any ${way}: ${lowerFirst(why)} Nothing changed.` }
  }
  const got = stretchNow(best.draft.points, best.from, best.to, ground).middle
  const lower = got < now.middle
  let done = got < 0.05 ? 'Brought that stretch down to the ground. Undo puts it back.' : `${lower ? 'Lowered' : 'Raised'} that stretch: its middle is ${metresWords(got)} above the ground now, ${lower ? 'easing down' : 'rising smoothly'} from each end. Undo puts it back.`
  // How long a stretch the height asked for needs (at least a little longer than this one).
  const need = Math.max(Math.ceil(stretchFor(want - now.middle, v) / 10) * 10, Math.ceil((now.metres * 1.2) / 10) * 10)
  const longer = `Select about ${need} m of road to go to ${metresWords(want)}.`
  if (bestH !== target) {
    done = `Only ${metresWords(got)} fits there: any further and ${lowerFirst(why)} It's ${metresWords(got)} now.${/take off/.test(why) ? ` ${longer}` : ''} Undo puts it back.`
  } else if (tooShort) {
    done = `This stretch is ${Math.round(now.metres)} m long, so its middle can only go to ${metresWords(got)}: any further and a car at ${kmh} km/h would take off over the top. ${longer} Undo puts it back.`
  }
  return { ok: true, draft: best.draft, height: got, limited: tooShort || bestH !== target, done, from: best.from, to: best.to }
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * One road point's "Height above the ground": the same smooth bump, centred
 * on the point, as long as it needs to be for a car to stay on at the speed
 * cars go there (at least 64 m). Returns the stretch to raise (`at` values).
 */
export function pointStretch(points: readonly RoadPoint[], index: number, wanted: number, runtime: TrackRuntime | null, ground: GroundFn = FLAT): { from: number; to: number; metres: number } {
  const line = roadLine(points)
  const sc = sOfPoint(line, index)
  const rise = Math.abs(Math.max(0, Math.min(RAISE_MAX, wanted)) - liftAt(line, index, ground))
  let metres = 64
  for (let pass = 0; pass < 2; pass++) {
    const from = atOf(line, sc - metres / 2)
    const to = atOf(line, sc + metres / 2)
    const v = stretchSpeed(runtime, points, from, to)
    metres = Math.min(line.length * 0.45, Math.max(64, Math.ceil(stretchFor(rise, v) * 1.05)))
  }
  return { from: atOf(line, sc - metres / 2), to: atOf(line, sc + metres / 2), metres }
}
