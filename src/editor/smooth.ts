// ============================================================
//  SMOOTH THE BUMPS - iron the little bumps out of a stretch of road
// ------------------------------------------------------------
//  A road with no height of its own rides the ground under it, and
//  on hilly worlds the ground has small bumps a car feels (or flies
//  off) at speed. The track's Road surface setting smooths every
//  road a little; this is the Height tool's "Smooth the bumps here"
//  for ONE stretch Josh picks.
//
//  What it does to the stretch:
//    1. Reads the road's height every metre along it, from the last
//       road point at or before its start to the first at or after
//       its end.
//    2. Finds the smoothest line through those heights that stays
//       close to them (stiffLine). Bumps shorter than a set length
//       are ironed out; rises and falls longer than that are kept, so
//       the road still climbs the big hill and dips into the valley.
//    3. Holds both ends of the line where the road is, at the same
//       height and slope, so the smoothed road meets the road either
//       side with no step and no kink. A bridge the stretch goes over
//       (or under) keeps its room: near the crossing the deck may
//       only go up, and the road under it only down.
//    4. Gives every point in the stretch its new height, keeping its
//       own kind of height: a `y` stays a `y`, anything else gets a
//       `lift` (metres above or below the ground under it).
//
//  How smooth: the gentlest that does the job. The bump length is
//  tried from short to long (SMOOTH_LENGTHS), and the first where a
//  car at the speed cars go there feels no bump more than SMOOTH_G
//  (a share of gravity, up over a crest or down into a dip) is
//  used. A stretch that already passes that is left alone. The last
//  few metres at each end don't count (endMetres): they have to meet
//  the road either side, so they can't be smoothed from inside.
//
//  Like every Height change, the result is built with the real
//  track builder and judged by the game's checks before it lands
//  (judge.ts): nothing that passed may fail, and nowhere may a car
//  take off where it didn't before (raise.ts launchOver).
//
//  Pure: drafts in, drafts out. stretchTools.ts wires it to the
//  panel's button; selfTestSmooth.ts checks it.
// ============================================================

import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import { SURFACE_CODE, type TrackRuntime } from '../track/types'
import { trackInternals } from '../track/build'
import { WALL_REACH } from '../track/road'
import { CLEANUP } from './cleanup'
import type { Draft } from './draft'
import { BRIDGE_GAP, type GroundFn, roadCrossings } from './bridges'
import { LOOP_RUN_IN } from './road'
import { atOf, densify, pointHeight, roadHeightAt, roadLine, sOf, sOfPoint, wrapS, type RoadLine } from './shape'
import { gateTitle, isGameBug, judgeDraft, newFailures } from './judge'
import { type RaiseOptions, launchHalf, launchOver, markWords, stretchSamples, stretchSpeed } from './raise'

/** A car may feel at most this share of gravity over a bump (up over a crest, or down into a dip) on a smoothed stretch. */
export const SMOOTH_G = 0.4
/** How long a bump may be and still be ironed out, metres: tried shortest first (see stiffLine). */
export const SMOOTH_LENGTHS = [40, 60, 80, 120, 160, 240, 320, 480] as const
/** A stretch whose road would move less than this anywhere (metres) is already smooth. */
export const SMOOTH_MIN_CHANGE = 0.1
/** The shortest stretch that can be smoothed, metres. */
export const SMOOTH_MIN_METRES = 60
/** Bumps are measured from the change of slope over this far either way, metres (the game's ride check does the same). */
const BUMP_HALF = 5
const G = 9.81
const FLAT: GroundFn = () => 0

// ---------------------------------------------------------------- measuring bumps

/** How bumpy a stretch of road is, for a car at `kmh`. */
export interface Bumpiness {
  /** How much road was measured. */
  metres: number
  kmh: number
  /** The biggest push a bump gives, as a share of gravity (up over a crest or down into a dip). */
  worst: number
  /** Over crests only (a car goes light; at 1 it leaves the road). */
  crest: number
  /** 95 metres in 100 feel less than this. */
  p95: number
  /** Where the worst bump is, metres along what was measured. */
  s: number
}

/**
 * The bumpiness of a height profile: `y` every `step` metres along the road
 * (horizontal metres), for a car at `kmh`. The push at a spot is v^2 x the
 * change of slope there (over BUMP_HALF metres either way), as a share of g.
 */
export function profileBumpiness(y: ArrayLike<number>, step: number, kmh: number, flat: (i: number) => number = () => step): Bumpiness {
  const v = kmh / 3.6
  const h = Math.max(1, Math.round(BUMP_HALF / step))
  const loads: number[] = []
  let worst = 0
  let crest = 0
  let at = 0
  let metres = 0
  for (let i = h; i < y.length - h; i++) {
    let da = 0
    let db = 0
    for (let j = i - h; j < i; j++) da += flat(j)
    for (let j = i; j < i + h; j++) db += flat(j)
    if (da <= 0 || db <= 0) continue
    // + = the road tips down more steeply ahead than behind: a crest.
    const k = (Math.atan2(y[i] - y[i - h], da) - Math.atan2(y[i + h] - y[i], db)) / ((da + db) / 2)
    const g = (v * v * k) / G
    loads.push(Math.abs(g))
    metres += flat(i)
    if (Math.abs(g) > worst) {
      worst = Math.abs(g)
      at = i * step
    }
    if (g > crest) crest = g
  }
  loads.sort((a, b) => a - b)
  const p95 = loads.length ? loads[Math.min(loads.length - 1, Math.floor(loads.length * 0.95))] : 0
  return { metres, kmh, worst, crest, p95, s: at }
}

/** The road's height every metre from s0 for `len` metres (`at` positions on `line`), as the editor works it out. */
function heightsAlong(line: RoadLine, s0: number, len: number, ground: GroundFn): Float64Array {
  const n = Math.max(2, Math.round(len) + 1)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = roadHeightAt(line.points, atOf(line, s0 + i), ground)
  return out
}

/**
 * How far in from each end of a stretch `metres` long its bumps are not counted
 * when judging how smooth it is, metres. The ends stay where the road either
 * side is (they have to meet it), so a bump right at an end can't be ironed out
 * from inside the stretch; counting it would make every press want more.
 */
export function endMetres(metres: number): number {
  return Math.min(40, metres * 0.12)
}

/**
 * The bumpiness of the stretch from `from` to `to` on a draft's road (the
 * editor's own heights, no build needed), leaving out `trim` metres at each end.
 */
export function draftBumpiness(points: readonly RoadPoint[], from: number, to: number, kmh: number, ground: GroundFn = FLAT, trim = 0): Bumpiness {
  const line = roadLine(points)
  const s0 = sOf(line, from)
  const len = wrapS(sOf(line, to) - s0, line.length)
  const t = Math.min(trim, Math.max(0, len / 2 - 10))
  return profileBumpiness(heightsAlong(line, s0 + t, len - 2 * t, ground), 1, kmh)
}

/**
 * The bumpiness of the stretch from `from` to `to` (`at` values on the draft
 * it was built from, `count` points) on a BUILT road: where the road's middle
 * really is, unbanked (the bank's pivot lift taken off, like the game's ride
 * check). This is what `__dev.editor('roughness')` reports.
 */
export function builtBumpiness(t: TrackRuntime, from: number, to: number, count: number, kmh = 180): Bumpiness {
  const S = t.samples
  const x = trackInternals(t)
  const idx = stretchSamples(t, from, to, count, 0).filter((i) => S.surface[i] === SURFACE_CODE.road)
  const y = idx.map((i) => S.py[i] - (x ? x.pivotLift[i] : 0))
  const flat = (k: number) => (k + 1 < idx.length ? Math.hypot(S.px[idx[k + 1]] - S.px[idx[k]], S.pz[idx[k + 1]] - S.pz[idx[k]]) : 0)
  return profileBumpiness(y, S.ds, kmh, flat)
}

// ---------------------------------------------------------------- the smoothed heights

export interface SmoothInput {
  points: readonly RoadPoint[]
  pieces: readonly Piece[]
  startAt: number
  /** The ground under road points (exact, from the draft's world); without it, flat ground. */
  pointGround?: GroundFn
}

export interface SmoothPlan {
  ok: boolean
  /** Why not: 'short' (the stretch), 'pieces' (a loop, ramp or wall ride, or the start grid), 'bridge' (a bridge would be squashed). */
  why?: 'short' | 'pieces' | 'bridge'
  reason?: string
  points: RoadPoint[]
  /** Old `at` to new `at`. */
  mapAt: (at: number) => number
  /** The most any point's height changed, metres: the biggest bump ironed out. */
  biggest: number
  /** The stretch's length, metres. */
  metres: number
}

/** Samples at each end of the stretch held exactly where they are: two fix the road's height and slope there. */
const HELD_ENDS = 2
/** Where two roads meet level, the stretch is held where it is this far either side of the spot, metres. */
const BRIDGE_HOLD = 4
/** Where the stretch goes over (or under) a bridge, it may only move away from the other road this far either side of the crossing, metres. */
const BRIDGE_KEEP = 30

/**
 * The smoothest line through `h` (heights 1 m apart) that stays close to it:
 * the heights z that make
 *     sum (z - h)^2  +  stiff x sum (bend of z)^2
 * as small as they can be, where the bend is z[i-1] - 2 z[i] + z[i+1]. The
 * first and last HELD_ENDS heights are held where they are, so the line leaves
 * the road either side at the same height and slope: no step, no kink. So are
 * the heights `held` marks (a bridge deck, so it keeps its gap).
 *
 * `stiff` sets how smooth: bumps much shorter than 2 pi x stiff^(1/4) metres
 * are ironed flat, rises and falls much longer than that are kept. (This is
 * the "Whittaker smoother"; the sums make a five-wide band of equations,
 * solved here in one pass down and one back up.)
 */
export function stiffLine(h: ArrayLike<number>, stiff: number, held?: ArrayLike<number>): Float64Array {
  const n = h.length
  // The equations, one row per height: d0 on the diagonal, d1 and d2 one and two to the right (they mirror to the left).
  const d0 = new Float64Array(n)
  const d1 = new Float64Array(n)
  const d2 = new Float64Array(n)
  const rhs = new Float64Array(n)
  const HOLD = 1e9
  for (let i = 0; i < n; i++) {
    const w = i < HELD_ENDS || i >= n - HELD_ENDS || held?.[i] ? HOLD : 1
    d0[i] = w
    rhs[i] = w * h[i]
  }
  const c = [1, -2, 1]
  for (let r = 0; r + 2 < n; r++) {
    for (let a = 0; a < 3; a++) {
      d0[r + a] += stiff * c[a] * c[a]
      if (a < 2) d1[r + a] += stiff * c[a] * c[a + 1]
      if (a < 1) d2[r + a] += stiff * c[a] * c[a + 2]
    }
  }
  // Split the band into L x L-transposed (L has the diagonal and two below it), then solve down and up.
  const l0 = new Float64Array(n)
  const l1 = new Float64Array(n)
  const l2 = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    l2[i] = i >= 2 ? d2[i - 2] / l0[i - 2] : 0
    l1[i] = i >= 1 ? (d1[i - 1] - (i >= 2 ? l2[i] * l1[i - 1] : 0)) / l0[i - 1] : 0
    l0[i] = Math.sqrt(Math.max(1e-12, d0[i] - l1[i] * l1[i] - l2[i] * l2[i]))
    y[i] = (rhs[i] - (i >= 1 ? l1[i] * y[i - 1] : 0) - (i >= 2 ? l2[i] * y[i - 2] : 0)) / l0[i]
  }
  const z = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    z[i] = (y[i] - (i + 1 < n ? l1[i + 1] * z[i + 1] : 0) - (i + 2 < n ? l2[i + 2] * z[i + 2] : 0)) / l0[i]
  }
  return z
}

/**
 * stiffLine with some heights only allowed to move one way. `keep[i]`:
 *    1  may go up but not down (a bridge deck: a car must still fit under it)
 *   -1  may go down but not up (the road under a bridge)
 *    2  stays exactly where it is
 *    0  free
 * Solved, then any height that broke its rule is held where it was and it is
 * solved again, until none do (a few rounds).
 */
export function stiffLineKept(h: ArrayLike<number>, stiff: number, keep: ArrayLike<number>): Float64Array {
  const held = Uint8Array.from({ length: h.length }, (_, i) => (keep[i] === 2 ? 1 : 0))
  let z = stiffLine(h, stiff, held)
  for (let round = 0; round < 12; round++) {
    let broke = false
    for (let i = 0; i < h.length; i++) {
      if (held[i]) continue
      if ((keep[i] === 1 && z[i] < h[i] - 1e-3) || (keep[i] === -1 && z[i] > h[i] + 1e-3)) {
        held[i] = 1
        broke = true
      }
    }
    if (!broke) break
    z = stiffLine(h, stiff, held)
  }
  return z
}

/** The stiffness that irons out bumps shorter than about `metres` (see stiffLine). */
export function stiffFor(metres: number): number {
  return (metres / (2 * Math.PI)) ** 4
}

function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

const PIECE_WORDS: Partial<Record<Piece['type'], string>> = { loop: 'loop', ramp: 'ramp', wallride: 'wall ride' }

/**
 * The road with the stretch from `from` to `to` laid on the smoothest line
 * that keeps bumps longer than `metres` (stiffLine), held to the road at both
 * ends. Only the shape is worked out here; smoothDraft builds it and judges it.
 */
export function planSmooth(input: SmoothInput, from: number, to: number, metres: number): SmoothPlan {
  const ground = input.pointGround ?? FLAT
  const original = input.points
  const line0 = roadLine(original)
  const span = wrapS(sOf(line0, to) - sOf(line0, from), line0.length)
  const refuse = (why: SmoothPlan['why'], reason: string): SmoothPlan => ({ ok: false, why, reason, points: original.map((p) => ({ ...p })), mapAt: (at) => at, biggest: 0, metres: span })
  if (span < SMOOTH_MIN_METRES) return refuse('short', `That stretch is only ${Math.round(span)} m long. Pick at least ${SMOOTH_MIN_METRES} m of road to smooth.`)
  if (span > line0.length - 60) return refuse('short', 'That is nearly the whole road. Pick a shorter stretch to smooth.')

  // Close, even points all round (what the Height tool does), so the smoothed line has points to sit on.
  const even = densify(line0, 0, line0.length, 20, CLEANUP.spacing, { pointGround: input.pointGround })
  const pts = even.points
  const line = roadLine(pts)
  const L = line.length
  // From the last road point at or before the stretch's start to the first at or after its end:
  // those two stay where they are, and every point between them gets its height from the line.
  const n = pts.length
  const kFrom = Math.floor(even.mapAt(from) + 1e-6) % n
  const kTo = Math.ceil(even.mapAt(to) - 1e-6) % n
  const t0 = sOfPoint(line, kFrom)
  const len = wrapS(sOfPoint(line, kTo) - t0, L)

  // The heights every metre along the stretch, and the smooth line through them.
  const H = heightsAlong(line, t0, len, ground)
  const step = len / (H.length - 1)
  // A bridge over or under the stretch keeps its gap: near the crossing, a deck may only go up
  // and the road under it only down. Where two roads meet level, the road stays where it is.
  const keep = new Int8Array(H.length)
  for (const c of roadCrossings(original, ground)) {
    c.passes.forEach((pass, k) => {
      const d = wrapS(sOf(line, even.mapAt(pass.at)) - t0, L)
      if (d > len) return
      const rule = c.over === null ? 2 : c.over === k ? 1 : -1
      const reach = rule === 2 ? BRIDGE_HOLD : BRIDGE_KEEP
      for (let i = Math.max(0, Math.floor((d - reach) / step)); i <= Math.min(H.length - 1, Math.ceil((d + reach) / step)); i++) keep[i] = keep[i] === 0 ? rule : 2
    })
  }
  const Z = stiffLineKept(H, stiffFor(metres), keep)
  const lineAt = (d: number) => {
    const f = Math.max(0, Math.min(H.length - 1, d / step))
    const i = Math.min(H.length - 2, Math.floor(f))
    return Z[i] + (Z[i + 1] - Z[i]) * (f - i)
  }
  let biggest = 0
  const next = pts.map((p, k) => {
    const d = wrapS(sOfPoint(line, k) - t0, L)
    if (d <= 0 || d >= len) return p
    const was = pointHeight(p, ground)
    const want = lineAt(d)
    if (Math.abs(want - was) < 0.005) return p
    const g = ground(p.x, p.z)
    const out: RoadPoint = { ...p }
    if (typeof p.y === 'number') out.y = roundCm(want)
    else {
      const l = Math.max(-30, roundCm(want - g))
      if (l === 0) delete out.lift
      else out.lift = l
    }
    biggest = Math.max(biggest, Math.abs(pointHeight(out, ground) - was))
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

  // Bridges: one that has room for a car keeps it.
  for (const c of roadCrossings(original, ground)) {
    if (c.over === null || c.gap < BRIDGE_GAP) continue
    const dh = [change(c.passes[0].at), change(c.passes[1].at)]
    if (Math.abs(dh[0]) < 0.05 && Math.abs(dh[1]) < 0.05) continue
    const top = c.over
    const gap = top === 0 ? c.passes[0].height + dh[0] - (c.passes[1].height + dh[1]) : c.passes[1].height + dh[1] - (c.passes[0].height + dh[0])
    // It may not squash a bridge: no less room than it had, or than a car needs with a little to spare.
    if (gap >= Math.min(c.gap, BRIDGE_GAP + 0.3) - 0.05) continue
    const where = markWords(line0, input.startAt, c.passes[top].at)
    return refuse('bridge', `This stretch runs over or under the bridge at ${where}, and smoothing it would leave only ${Math.max(0, gap).toFixed(1)} m between the roads (it has ${c.gap.toFixed(1)} m now). Pick a stretch that stops before the bridge.`)
  }

  // Pieces that need their road as it is: loops, ramps and wall rides, and the start grid.
  for (const piece of input.pieces) {
    const word = PIECE_WORDS[piece.type]
    if (!word) continue
    const spanOf =
      piece.type === 'loop'
        ? [-(LOOP_RUN_IN + 10), LOOP_RUN_IN + 5 * (piece.radius ?? TRACK_DEFAULTS.loopRadius)]
        : piece.type === 'wallride'
          ? [-WALL_REACH, (piece.length ?? TRACK_DEFAULTS.wallride.length) + WALL_REACH]
          : [-30, 30]
    if (changeAlong(piece.at, spanOf[0], spanOf[1]) > 0.3) {
      return refuse('pieces', `A ${word} is on this stretch (at ${markWords(line0, input.startAt, piece.at)}): smoothing would tip the road under it. Move the ${word} off it first, or pick a stretch without it.`)
    }
  }
  if (changeAlong(input.startAt, -70, 25) > 0.3) {
    return refuse('pieces', 'The start line is on this stretch: the cars on the grid need level road. Pick a stretch that stops 70 m before the start line.')
  }
  return { ok: true, points: next, mapAt: even.mapAt, biggest, metres: span }
}

// ---------------------------------------------------------------- building it for real

export interface SmoothResult {
  ok: boolean
  draft?: Draft
  /** Why not, or (with `already`) why nothing needed doing, in plain words. */
  reason?: string
  /** True when the stretch was already smooth (nothing changed, and nothing is wrong). */
  already?: boolean
  /** What happened, in plain words ("Smoothed 420 m: the biggest bump was 1.8 m."). */
  done?: string
  /** The biggest change, metres, and how long a bump it ironed out (SMOOTH_LENGTHS). */
  biggest?: number
  length?: number
  /** The stretch's bumpiness before and after, for a car at `kmh` (the editor's own heights). */
  before?: Bumpiness
  after?: Bumpiness
  kmh?: number
  /** True when it couldn't get the bumps under SMOOTH_G (it smoothed as much as the checks allow). */
  limited?: boolean
  /** The stretch on the new road (for keeping it selected). */
  from?: number
  to?: number
}

/** "8 m", "2.5 m", "0.4 m": a height in words. */
function metresWords(v: number): string {
  const r = Math.round(v * 10) / 10
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} m`
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * "Smooth the bumps here" on the stretch from `from` to `to`: the narrowest
 * running average that gets every bump under SMOOTH_G for a car at the speed
 * cars go there, built with the real builder and judged by the game's checks
 * (nothing that passed may fail) and the take-off rule (nowhere may a car get
 * lighter than it was). If the smoothest one fails a check, a gentler one is
 * tried. Never changes `d`.
 */
export function smoothDraft(d: Draft, from: number, to: number, o: RaiseOptions): SmoothResult {
  const ground = o.pointGround ?? FLAT
  const before =
    o.before ??
    (() => {
      const j = judgeDraft(d, o.id, o.params)
      return { runtime: j.runtime, gates: j.gates }
    })()
  const v = stretchSpeed(before.runtime, d.points, from, to)
  const kmh = Math.round((v * 3.6) / 10) * 10
  const line0 = roadLine(d.points)
  const metres = Math.round(wrapS(sOf(line0, to) - sOf(line0, from), line0.length))
  // Judged inside the stretch, short of its ends (see endMetres).
  const trim = endMetres(metres)
  const was = draftBumpiness(d.points, from, to, kmh, ground, trim)
  if (metres < SMOOTH_MIN_METRES) return { ok: false, reason: `That stretch is only ${metres} m long. Pick at least ${SMOOTH_MIN_METRES} m of road to smooth.` }
  const already = (): SmoothResult => ({
    ok: false,
    already: true,
    before: was,
    kmh,
    reason: `This ${metres} m stretch is already smooth: no bump on it is big enough to bother a car at ${kmh} km/h. Nothing changed.`,
  })
  if (was.worst <= SMOOTH_G) return already()

  // Plans from the gentlest smoothing up; the first that gets every bump under SMOOTH_G is the one wanted.
  const input: SmoothInput = { points: d.points, pieces: d.pieces, startAt: d.startAt, pointGround: o.pointGround }
  const lengths = SMOOTH_LENGTHS.filter((m) => m === SMOOTH_LENGTHS[0] || m <= metres * 2)
  const plans: { length: number; plan: SmoothPlan; after: Bumpiness }[] = []
  for (const length of lengths) {
    const plan = planSmooth(input, from, to, length)
    if (!plan.ok) return { ok: false, before: was, kmh, reason: `${plan.reason} Nothing changed.` }
    const after = draftBumpiness(plan.points, plan.mapAt(from), plan.mapAt(to), kmh, ground, trim)
    plans.push({ length, plan, after })
    if (after.worst <= SMOOTH_G) break
  }
  // The one wanted first, then gentler ones (if it is smooth enough), or else the smoothest first.
  const reached = plans[plans.length - 1].after.worst <= SMOOTH_G
  const order = reached ? [...plans].reverse() : [...plans].sort((a, b) => a.after.worst - b.after.worst)
  if (plans.every((x) => x.plan.biggest < SMOOTH_MIN_CHANGE)) return already()

  // Build and judge that one; if the game says no, step back to gentler smoothing.
  let why = ''
  for (const { length, plan, after } of order) {
    // Only worth landing if it is smoother than the road is now.
    if (after.worst >= was.worst - 0.02 || plan.biggest < SMOOTH_MIN_CHANGE) continue
    const next: Draft = {
      ...d,
      points: plan.points,
      pieces: d.pieces.map((p) => ({ ...p, at: Math.round(plan.mapAt(p.at) * 1000) / 1000 })),
      startAt: Math.round(plan.mapAt(d.startAt) * 1000) / 1000,
    }
    const newFrom = plan.mapAt(from)
    const newTo = plan.mapAt(to)
    const judged = judgeDraft(next, o.id, o.params, before.runtime)
    if (!judged.runtime) {
      why = why || `the game couldn't build the road that way (${judged.error}).`
      continue
    }
    const fresh = newFailures(before.gates, judged.gates)
    if (fresh.length) {
      const g = fresh.find((x) => !isGameBug(x)) ?? fresh[0]
      why = why || (isGameBug(g) ? `the game can't build it cleanly (${gateTitle(g, next)} That's the game's fault, not your track.)` : lowerFirst(gateTitle(g, next)))
      continue
    }
    const launch = launchOver(judged.runtime, before.runtime, stretchSamples(judged.runtime, newFrom, newTo, next.points.length, 30), v, launchHalf(metres))
    if (launch.over > 0) {
      why = why || `a car at ${kmh} km/h would take off over it.`
      continue
    }
    const limited = after.worst > SMOOTH_G
    // Held back by a check, or by the stretch's ends (they stay where the road around them is).
    const more = !limited ? '' : why ? ` Any smoother and ${why}` : ' To smooth it more, pick a longer stretch: its ends have to meet the road either side.'
    const done = `Smoothed ${metres} m: the biggest bump was ${metresWords(plan.biggest)}.${more} Undo puts it back.`
    return { ok: true, draft: next, done, biggest: plan.biggest, length, before: was, after, kmh, limited, from: newFrom, to: newTo }
  }
  if (!why) {
    // Nothing came out smoother: the bumps are where the road has to stay put (a bridge it goes over or under).
    const bridge = roadCrossings(d.points, ground).find((c) => c.passes.some((p) => wrapS(sOf(line0, p.at) - sOf(line0, from), line0.length) <= metres))
    why = bridge
      ? `its bumps are on the bridge at ${markWords(line0, d.startAt, bridge.passes[0].at)}, and a bridge keeps its height. Pick a stretch that stops before the bridge.`
      : 'smoothing it would not make it any smoother.'
  }
  return { ok: false, before: was, kmh, reason: `Can't smooth that stretch: ${why} Nothing changed.` }
}
