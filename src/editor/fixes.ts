// ============================================================
//  FIXES - the Checks panel's Fix it button
// ------------------------------------------------------------
//  For a problem whose remedy is 'fix' (problems.ts), this works out
//  a few ways of mending it, gentlest first (a small smoothing before
//  a bigger one, say), and tries them in turn. Each try is built with
//  the real track builder and judged by the game's own checks
//  (judge.ts). The first one that makes the problem go away WITHOUT
//  making any other check fail is the fix. If none does, nothing
//  changes and Josh is told why, with the way to do it by hand.
//
//  What each fix does (the full table is in the editor8 report):
//    KINK, RACING LINE, tight corner   smooth the road around the spot,
//                                      a little first, then more (a kink
//                                      can also be up and down: the
//                                      heights there get smoothed too)
//    SUDDEN TILT, CAR GOES LIGHT       ease the bank over a longer stretch
//                                      (smoothing the bank the road has
//                                      now into gentle hand-set banking),
//                                      or bank less, or smooth the road
//    LOW BRIDGE (and the ground under  lift the upper road onto the
//      it, and roads that meet)        clean-up's 8 m bridge (bridges.ts)
//    LOOP BLOCKED, loop warnings       move the loop to the nearest
//                                      straight, level stretch that works
//    a loop that twists too fast       make it as big as the game says
//    START ON A BEND                   move the start line to a straight
//    points on top of each other       take one out
//    off the edge of the world         pull it back in
//    a piece on the start grid, two    move it along the road
//      pieces overlapping
//    a ramp off the road's edge        slide it back on
//
//  Pure: drafts in, drafts out. Checked by selfTestFixes.ts.
// ============================================================

import { TRACK_DEFAULTS, type RoadPoint } from '../track/schema'
import { type TrackGate, crossingClearance } from '../track/gates'
import { SURFACE_CODE, type NearestHit, type TrackRuntime } from '../track/types'
import { trackInternals } from '../track/build'
import { circularSmooth } from '../track/road'
import type { StrokeIssue } from './cleanup'
import type { Draft } from './draft'
import { roadBound } from './draftFile'
import { BRIDGE_GAP, type GroundFn, crossingNear, roadCrossings, swapDraft, tryOneWay, underDraft } from './bridges'
import { liftBridgeBy } from './bankBridges'
import { type BankRegion, bankRegions, handBankNear, regionNear } from './handBanks'
import { type P, circumradius, dist } from './geom'
import { LOOP_MIN_RADIUS, LOOP_RUN_IN, advanceAt, atAfterDelete, frameAt, metresBetween, nearestOnRoad, roadCurve, wrapAt } from './road'
import { type KeepZone, type ShapeWorld, MIN_RADIUS, SMOOTH_SIGMA, atOf, densify, nearestStraightStart, pointHeight, posOf, roadLine, sOf, sOfPoint, smoothRoad, tightestBetween, wrapS } from './shape'
import { type Judged, gateTitle, isGameBug, judgeDraft, newFailures } from './judge'
import { NO_NOTES, type Problem, gateAts, problemsOf } from './problems'

export interface FixContext {
  /** The id the draft builds under. */
  id: string
  /** Live track parameters (a bank slider), as the preview builds with. */
  params?: Record<string, number>
  /** The draft's world, for the shaping maths (draft.ts shapeWorld). */
  world: ShapeWorld
  /** The draft as it is now, built and checked. */
  before: Judged
  /** Carries crash props and energy cores beside a road that moved (draft.ts carryAlongside). */
  carry?: (d: Draft, oldPoints: RoadPoint[], mapAt: (at: number) => number) => void
}

/** One way of mending a problem: the mended draft, and what was done in Josh's words. */
export interface Candidate {
  draft: Draft
  did: string
}

export interface FixResult {
  ok: boolean
  draft?: Draft
  /** What was done, in plain words. */
  did?: string
  /** Why not, in plain words. */
  reason?: string
  /** The mended draft, built and checked. */
  after?: Judged
}

/** At most this many ways are tried for one problem (each is a full build and check). */
const MAX_TRIES = 10

const FLAT: GroundFn = () => 0

// ---------------------------------------------------------------- small helpers

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

/** The draft with new road points: pieces, the start line, props and cores follow the road. */
function withPoints(d: Draft, points: RoadPoint[], mapAt: (at: number) => number, ctx: FixContext): Draft {
  const next: Draft = {
    ...d,
    points,
    pieces: d.pieces.map((p) => ({ ...p, at: round3(mapAt(p.at)) })),
    startAt: round3(mapAt(d.startAt)),
    props: d.props.map((p) => ({ ...p })),
    cores: d.cores.map((c) => ({ ...c })),
  }
  ctx.carry?.(next, d.points, mapAt)
  return next
}

/** The road with close, even points all round (the road does not move): every fix that reshapes works on this. */
function evened(d: Draft, ctx: FixContext): { points: RoadPoint[]; mapAt: (at: number) => number } {
  const line = roadLine(d.points)
  return densify(line, 0, line.length, 20, undefined, ctx.world)
}

/** The `at` of a problem: where on the road it is (or nearest its pin). */
function problemAt(p: Problem, d: Draft): number | null {
  if (p.roadAt !== null) return p.roadAt
  if (!p.at || !d.points.length) return null
  return nearestOnRoad(roadCurve(d.points), p.at).at
}

/** A weight that is 1 at the middle of a window `reach` metres each way and eases to 0 at its edges. */
function windowWeight(d: number, reach: number): number {
  const t = Math.abs(d) / reach
  if (t >= 1) return 0
  const c = Math.cos((t * Math.PI) / 2)
  return c * c
}

// ---------------------------------------------------------------- ways to mend the road

/**
 * Smooth the road's line within `reach` metres of `at` (shape.ts smoothRoad,
 * with everything further away held still), `passes` times; with `at` null,
 * the whole road (what Smooth the road does). Loops' run-ins and the start
 * grid stay as they are. Points that end up bunched together (a hairpin
 * pulled open) are thinned out, so the file never has two within 4 m.
 */
function smoothNear(d: Draft, at: number | null, reach: number, passes: number, ctx: FixContext): Candidate | null {
  const even = evened(d, ctx)
  const line = roadLine(even.points)
  const L = line.length
  const r = Math.min(reach, L / 2 - 60)
  if (at !== null && r < 30) return null
  const keep: KeepZone[] = [
    ...d.pieces.flatMap((p) => (p.type === 'loop' ? [{ at: even.mapAt(p.at), before: LOOP_RUN_IN + 20, after: 2.6 * (p.radius ?? TRACK_DEFAULTS.loopRadius) + 40 }] : [])),
    { at: even.mapAt(d.startAt), before: 60, after: 15 },
  ]
  // Everything further than `r` from the spot: a keep zone centred on the far side of the lap.
  if (at !== null) keep.push({ at: atOf(line, sOf(line, even.mapAt(at)) + L / 2), before: L / 2 - r, after: L / 2 - r })
  let pts = even.points
  for (let k = 0; k < passes; k++) pts = smoothRoad(pts, ctx.world, SMOOTH_SIGMA, keep).points
  const moved = Math.max(...pts.map((p, i) => Math.hypot(p.x - even.points[i].x, p.z - even.points[i].z)))
  if (moved < 0.2) return null
  const thin = thinBunched(pts, even.mapAt)
  const where = at === null ? 'the whole road' : `${Math.round(2 * r)} m of road there`
  return { draft: withPoints(d, thin.points, thin.mapAt, ctx), did: `smoothed ${where}${passes > 1 ? `, ${passes} times over` : ''}.` }
}

/** Take out any point closer than 4 m to the one before it; `mapAt` (old road to these points) follows. */
function thinBunched(points: RoadPoint[], mapAt: (at: number) => number): { points: RoadPoint[]; mapAt: (at: number) => number } {
  let pts = points
  let map = mapAt
  for (let guard = 0; guard < 40 && pts.length > 8; guard++) {
    const i = pts.findIndex((p, k) => k > 0 && dist(p, pts[k - 1]) < 4)
    if (i < 0) break
    const count = pts.length
    const before = map
    pts = pts.filter((_, k) => k !== i)
    map = (a) => atAfterDelete(before(a), i, count)
  }
  return { points: pts, mapAt: map }
}

/** Smooth the road's heights (up and down) within `reach` metres of `at`, keeping each point's kind of height. */
function smoothHeightsNear(d: Draft, at: number, reach: number, ctx: FixContext): Candidate | null {
  const ground = ctx.world.pointGround ?? FLAT
  const even = evened(d, ctx)
  const pts = even.points
  const line = roadLine(pts)
  const L = line.length
  const s0 = sOf(line, even.mapAt(at))
  const n = pts.length
  const h = pts.map((p) => pointHeight(p, ground))
  let changed = false
  const out = pts.map((p, k) => {
    const w = windowWeight(wrapS(sOfPoint(line, k) - s0 + L / 2, L) - L / 2, reach)
    if (w <= 0) return p
    // A Gaussian over the neighbours (about 25 m each way).
    let sum = 0
    let wsum = 0
    for (let j = -4; j <= 4; j++) {
      const g = Math.exp(-(j * j) / (2 * 1.6 * 1.6))
      sum += h[(((k + j) % n) + n) % n] * g
      wsum += g
    }
    const target = h[k] + (sum / wsum - h[k]) * w
    if (Math.abs(target - h[k]) < 0.01) return p
    changed = true
    const q: RoadPoint = { ...p }
    if (typeof p.y === 'number') q.y = roundCm(target)
    else {
      const l = roundCm(target - ground(p.x, p.z))
      if (l === 0) delete q.lift
      else q.lift = Math.max(-30, l)
    }
    return q
  })
  if (!changed) return null
  return { draft: withPoints(d, out, even.mapAt, ctx), did: `smoothed the ups and downs of ${Math.round(2 * reach)} m of road there.` }
}

/**
 * Ease the bank within `reach` metres of `at`: the bank the road has now
 * (read off the built road) is smoothed along the road and set by hand there,
 * so it rolls in and out over a longer stretch. `scale` banks less as well.
 */
function easeBank(d: Draft, at: number, reach: number, scale: number, ctx: FixContext): Candidate | null {
  const t = ctx.before.runtime
  if (!t) return null
  const ground = ctx.world.pointGround ?? FLAT
  const even = evened(d, ctx)
  const pts = even.points
  const line = roadLine(pts)
  const L = line.length
  const s0 = sOf(line, even.mapAt(at))
  const S = t.samples
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const W = Math.max(1, Math.round(30 / S.ds))
  // The bank at each point, "into the corner" the way a `bank` setting means it (road.ts: right-handers and straights lift the left edge).
  const into = pts.map((p, k) => {
    const d0 = wrapS(sOfPoint(line, k) - s0 + L / 2, L) - L / 2
    if (Math.abs(d0) > reach * 1.6) return 0
    t.nearest(p.x, pointHeight(p, ground), p.z, hit)
    let k30 = 0
    for (let j = -W; j <= W; j++) k30 += S.curvature[(((hit.index + j) % S.count) + S.count) % S.count]
    const sgn = k30 / (2 * W + 1) >= -1 / 1500 ? 1 : -1
    return ((S.bank[hit.index] * 180) / Math.PI) * sgn
  })
  const n = pts.length
  const sigma = Math.max(1, reach / 3 / 16)
  const span = Math.ceil(sigma * 2.5)
  let changed = false
  const out = pts.map((p, k) => {
    const d0 = wrapS(sOfPoint(line, k) - s0 + L / 2, L) - L / 2
    const w = windowWeight(d0, reach)
    if (w <= 0) return p
    let sum = 0
    let wsum = 0
    for (let j = -span; j <= span; j++) {
      const g = Math.exp(-(j * j) / (2 * sigma * sigma))
      sum += into[(((k + j) % n) + n) % n] * g
      wsum += g
    }
    const eased = (into[k] + (sum / wsum - into[k]) * w) * (1 - (1 - scale) * w)
    const bank = Math.round(eased * 2) / 2
    if (p.bank === bank) return p
    changed = true
    return { ...p, bank }
  })
  if (!changed) return null
  return { draft: withPoints(d, out, even.mapAt, ctx), did: `eased the tilt over ${Math.round(2 * reach)} m of road there${scale < 1 ? ', with less bank' : ''} (set by hand: the Bank tool's Auto puts it back).` }
}

/** Bank set by hand within `reach` metres of `at`, times `scale` (0: back to automatic). */
function scaleBankNear(d: Draft, at: number, reach: number, scale: number, ctx: FixContext): Candidate | null {
  const line = roadLine(d.points)
  const s0 = sOf(line, at)
  let changed = false
  const out = d.points.map((p, k) => {
    if (p.bank === undefined || Math.abs(wrapS(sOfPoint(line, k) - s0 + line.length / 2, line.length) - line.length / 2) > reach) return p
    changed = true
    const q = { ...p }
    // Scale 0: back to automatic banking (no setting at all).
    if (scale === 0) delete q.bank
    else q.bank = Math.round(p.bank * scale * 2) / 2
    return q
  })
  if (!changed) return null
  return { draft: withPoints(d, out, (a) => a, ctx), did: scale === 0 ? 'put the bank there back to automatic.' : `banked the road there ${Math.round((1 - scale) * 100)}% less.` }
}

// ---------------------------------------------------------------- banks Josh set by hand

/** How fast a car can be going there, at most (the crest check's own top speed), m/s. */
const TOP_SPEED = 250 / 3.6
/** A spread roll is planned to ask this much of gravity at most (under the crest check's 80%, for the 3D road's extras). */
const ROLL_PLAN = 0.55
/** The smootherstep's steepest bend (its second derivative's peak): see bankRolls.ts. */
const S_PEAK = 10 / Math.sqrt(3)
const DEG = Math.PI / 180

/** 0 -> 1 with no slope and no bend at either end. */
function smootherstep(u: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/** The built road's bend smoothed the way the game smooths it before reading a `bank` setting's side (road.ts bCurvWide). */
const sideBend = new WeakMap<TrackRuntime, Float32Array>()

/** Which way a `bank` setting leans at each point, the way the game reads it (road.ts): +1 lifts the left edge, -1 the right. */
function settingSides(points: readonly RoadPoint[], t: TrackRuntime, ground: GroundFn): number[] {
  const S = t.samples
  let bend = sideBend.get(t)
  if (!bend) {
    // The game reads a setting "into the corner" from the bend after two passes of a 30 m smoothing.
    bend = new Float32Array(S.curvature)
    circularSmooth(bend, Math.round(30 / S.ds), 2)
    sideBend.set(t, bend)
  }
  const b = bend
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  return points.map((p) => {
    t.nearest(p.x, pointHeight(p, ground), p.z, hit)
    return b[hit.index] >= -1 / 1500 ? 1 : -1
  })
}

/** The built road's bank at a point, degrees (+ = left edge up), and the sample it is at. */
function builtBankAt(t: TrackRuntime, p: RoadPoint, ground: GroundFn): { deg: number; index: number } {
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  t.nearest(p.x, pointHeight(p, ground), p.z, hit)
  return { deg: t.samples.bank[hit.index] / DEG, index: hit.index }
}

/**
 * How long a roll from one bank to another (degrees apart, at most `bankDeg` steep)
 * needs to be so a car at `v` m/s on the outermost lane stays on: a smootherstep roll
 * of length L bends that lane by lane x S_PEAK x change / L^2 (bankRolls.ts).
 */
function rollMetres(changeDeg: number, bankDeg: number, lane: number, v: number): number {
  const need = (lane * S_PEAK * Math.abs(changeDeg) * DEG * v * v) / (ROLL_PLAN * G_ACC * Math.cos(Math.min(80, Math.abs(bankDeg)) * DEG))
  return Math.max(40, Math.sqrt(need))
}
const G_ACC = 9.81

/**
 * Rework a hand-set region so the road rolls into and out of it gently enough.
 *  scale     how much of Josh's bank to keep (1: all of it)
 *  stretch   how much longer than the bare minimum to make each roll
 * Inside the region every point keeps its bank (times `scale`), and the gaps
 * between his stretches get the bank either side, so the road doesn't roll out
 * and back in. The whole region leans the way most of it does (on a gentle bend
 * the game can read the same setting as leaning either way). Either side, new
 * hand-set points roll the bank in from what the road does there on its own,
 * over as much road as a car at top speed needs. Returns null if nothing changes
 * or there's no room.
 */
function spreadBank(d: Draft, region: BankRegion, scale: number, stretch: number, ctx: FixContext): Candidate | null {
  const t = ctx.before.runtime
  if (!t) return null
  const ground = ctx.world.pointGround ?? FLAT
  const even = evened(d, ctx)
  const pts = even.points
  const n = pts.length
  const line = roadLine(pts)
  const L = line.length
  // The region on the evened road: the old points' positions moved across.
  const k0 = Math.round(even.mapAt(region.k0 % d.points.length))
  const k1raw = Math.round(even.mapAt(region.k1 % d.points.length))
  const k1 = k1raw < k0 ? k1raw + n : k1raw
  if (k1 - k0 >= n - 4) return null
  const at = (k: number) => pts[((k % n) + n) % n]
  const sides = settingSides(pts, t, ground)
  const side = (k: number) => sides[((k % n) + n) % n]
  // The way the region leans (+ = left edge up), weighted by how much each point banks.
  let lean = 0
  for (let k = k0; k <= k1; k++) {
    const b = at(k).bank
    if (b !== undefined) lean += b * side(k) * Math.abs(b)
  }
  const physical = lean >= 0 ? 1 : -1
  // Each point's size of bank inside the region (gaps take the line between their neighbours).
  const mag: number[] = []
  for (let k = k0; k <= k1; k++) mag.push(Math.abs(at(k).bank ?? NaN))
  for (let i = 0; i < mag.length; i++) {
    if (!Number.isNaN(mag[i])) continue
    let a = i - 1
    while (a >= 0 && Number.isNaN(mag[a])) a--
    let b = i + 1
    while (b < mag.length && Number.isNaN(mag[b])) b++
    const va = a >= 0 ? mag[a] : mag[b]
    const vb = b < mag.length ? mag[b] : va
    mag[i] = va + ((vb - va) * (i - a)) / Math.max(1, b - a)
  }
  const out = pts.map((p) => ({ ...p }))
  const write = (k: number, physicalDeg: number) => {
    const q = out[((k % n) + n) % n]
    const v = Math.round(physicalDeg * side(k) * 2) / 2
    q.bank = Math.max(-60, Math.min(85, v))
  }
  for (let k = k0; k <= k1; k++) write(k, physical * mag[k - k0] * scale)
  // Where the road must stay level or as it is: the start grid, and loops with their run-ins.
  const sStart = sOf(line, even.mapAt(d.startAt))
  const busy = (s: number) => {
    const ahead = wrapS(s - sStart, L)
    if (ahead <= 30 || L - ahead <= 75) return true
    return d.pieces.some((p) => {
      if (p.type !== 'loop') return false
      const sl = sOf(line, even.mapAt(p.at))
      const a = wrapS(s - sl, L)
      return L - a <= LOOP_RUN_IN + 60 || a <= 2.6 * (p.radius ?? TRACK_DEFAULTS.loopRadius) + 80
    })
  }
  const others = bankRegions(d.points, roadLine(d.points)).filter((r) => r.k0 !== region.k0)
  const inOther = (k: number) => {
    const old = at(k)
    return old.bank !== undefined && (k < k0 || k > k1) && others.length > 0
  }
  // An open road tilts about its low edge, so its high lane swings the whole width (road.ts, the bank's pivot).
  const lane = Math.max(1, d.width - 1)
  // Each end of the region: roll from its edge bank to the road's own bank further out.
  let spread = 0
  for (const dir of [-1, 1] as const) {
    const edgeK = dir < 0 ? k0 : k1
    const edge = mag[dir < 0 ? 0 : mag.length - 1] * scale
    const sEdge = sOfPoint(line, ((edgeK % n) + n) % n)
    const vHere = Math.min(TOP_SPEED, t.racingLine.speed[builtBankAt(t, at(edgeK), ground).index] * 1.15)
    // What the road banks out there on its own (read off the built road well clear of the region), this way only.
    const far = builtBankAt(t, pts[Math.floor(atOf(line, sEdge + dir * 260)) % n], ground).deg * physical
    const goal = Math.max(0, Math.min(edge, far))
    const metres = rollMetres(edge - goal, edge, lane, vHere) * stretch
    spread = Math.max(spread, metres)
    for (let j = 1; j < n; j++) {
      const k = edgeK + dir * j
      const s = sOfPoint(line, ((k % n) + n) % n)
      const away = dir > 0 ? wrapS(s - sEdge, L) : wrapS(sEdge - s, L)
      if (away > metres + 1 || (k >= k0 && k <= k1) || (k + n >= k0 && k + n <= k1) || (k - n >= k0 && k - n <= k1)) break
      if (busy(s) || inOther(k)) return null
      write(k, physical * (goal + (edge - goal) * smootherstep(1 - away / metres)))
    }
  }
  const changed = out.some((p, k) => p.bank !== pts[k].bank)
  if (!changed) return null
  const kept = Math.round(scale * 100)
  const did =
    scale >= 1
      ? `spread the tilt in and out over about ${Math.round(spread / 10) * 10} m either side of the bank you set, so it rolls gently (your bank is kept).`
      : `spread the tilt in and out over about ${Math.round(spread / 10) * 10} m either side and banked that stretch ${100 - kept}% less (${Math.round(Math.max(...mag) * scale)} degrees at most), so it rolls gently.`
  return { draft: withPoints(d, out, even.mapAt, ctx), did }
}

/** Put a hand-set region back to automatic banking (the game banks it from the bend). */
function regionToAuto(d: Draft, region: BankRegion, ctx: FixContext): Candidate | null {
  const n = d.points.length
  const out = d.points.map((p, k) => {
    const inside = (k >= region.k0 && k <= region.k1) || (k + n >= region.k0 && k + n <= region.k1)
    if (!inside || p.bank === undefined) return p
    const q = { ...p }
    delete q.bank
    return q
  })
  if (out.every((p, k) => p === d.points[k])) return null
  return { draft: withPoints(d, out, (a) => a, ctx), did: 'put the bank on that stretch back to Auto (the game banks it to suit the bend).' }
}

/**
 * The ways to ease a CAR GOES LIGHT or SUDDEN TILT that a bank Josh set causes,
 * gentlest first and keeping as much of his bank as works: spread the roll over
 * more road, then less bank (three quarters, half, a third), then back to Auto.
 * None when no hand-set bank is near the problem.
 */
function* handBankWays(d: Draft, s0: number, s1: number, ctx: FixContext): Generator<Candidate> {
  const line = roadLine(d.points)
  const region = regionNear(d.points, line, s0, s1, 150)
  if (!region) return
  for (const c of [spreadBank(d, region, 1, 1, ctx), spreadBank(d, region, 1, 1.5, ctx), spreadBank(d, region, 0.75, 1.2, ctx), spreadBank(d, region, 0.5, 1.2, ctx), spreadBank(d, region, 0.3, 1.2, ctx), regionToAuto(d, region, ctx)]) {
    if (c) yield c
  }
}

/**
 * A LOW BRIDGE over road Josh banked by hand (the bank lifts the lower road's
 * middle towards the bridge, bankBridges.ts): raise the upper road by what the
 * built road is short of (and a little more), or, keeping the bridge, ease the
 * bank under it (less bank, then back to Auto). None when the road under the
 * bridge has no bank set by hand.
 */
function* bankedBridgeWays(d: Draft, spot: P, ctx: FixContext): Generator<Candidate> {
  const ground = ctx.world.pointGround ?? FLAT
  const c = crossingNear(roadCrossings(d.points, ground), spot, 60)?.crossing
  if (!c || c.over === null) return
  const under = c.passes[c.over === 0 ? 1 : 0]
  if (handBankNear(d.points, under.s) <= 0) return
  const t = ctx.before.runtime
  const gap = t ? crossingClearance(t)?.gap : undefined
  if (gap !== undefined) {
    for (const more of [0.6, 2]) {
      const need = BRIDGE_GAP + more - gap
      if (need <= 0) continue
      const r = liftBridgeBy(d.points, d.pieces, d.startAt, d.width, c.at, need, ground)
      if (r.ok) yield { draft: withPoints(d, r.points, r.mapAt, ctx), did: `raised the bridge ${need.toFixed(1)} m (with longer ramps) so a car fits under it over your banked road.` }
    }
  }
  const line = roadLine(d.points)
  const region = regionNear(d.points, line, under.s - UNDER_EASE, under.s + UNDER_EASE, 0)
  if (!region) return
  for (const cand of [spreadBank(d, region, 0.6, 1.2, ctx), spreadBank(d, region, 0.3, 1.2, ctx), regionToAuto(d, region, ctx)]) {
    if (cand) yield { draft: cand.draft, did: cand.did.replace(/so it rolls gently\.$/, 'so the road under the bridge stays low enough for a car.') }
  }
}
/** How far either side of the crossing the bank under a bridge counts, metres. */
const UNDER_EASE = 40

/** Lift the upper road at the crossing near `spot` onto a proper bridge (or swap, or make one where the roads meet). */
function* bridgeAt(d: Draft, spot: P, ctx: FixContext): Generator<Candidate> {
  const ground = ctx.world.pointGround ?? FLAT
  const hit = crossingNear(roadCrossings(d.points, ground), spot, 60)
  if (!hit) return
  const c = hit.crossing
  const o = { id: ctx.id, pointGround: ctx.world.pointGround, params: ctx.params, gatesBefore: ctx.before.gates }
  if (c.over !== null && c.kind === 'underpass') {
    // An underpass too shallow for a car: dig the lower road down to a full underpass first.
    const r = underDraft(d, c.at, c.over === 0 ? 1 : 0, o)
    if (r.ok && r.draft) yield { draft: r.draft, did: 'dug the lower road down into an 8 m cutting there so a car fits under the other road.' }
  }
  if (c.over !== null) {
    const r = tryOneWay(d, c.at, c.over, o)
    if (r.ok && r.draft) yield { draft: r.draft, did: 'lifted the upper road there onto an 8 m bridge with smooth ramps.' }
  }
  const s = swapDraft(d, c.at, o)
  if (s.ok && s.draft) yield { draft: s.draft, did: c.over === null ? 'made one road a bridge over the other there.' : 'put the other road on top there, on an 8 m bridge (the first one had no room for its ramps).' }
}

/**
 * Where a loop could go, nearest to `from` first: every spot (every 5 m) with
 * a straight run-in either side (no bend tighter than LOOP_MIN_RADIUS within
 * LOOP_RUN_IN metres, road.ts's own rule), on level road (read off the built
 * road), clear of the start grid and other pieces. One pass round the lap.
 */
function loopSpots(d: Draft, index: number, t: TrackRuntime | null, limit: number): number[] {
  const loop = d.pieces[index]
  const line = roadLine(d.points)
  const L = line.length
  const N = Math.floor(L)
  // The road's bend every metre (circle through spots 6 m either side).
  const bend = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const r = circumradius(posOf(line, i - 6), posOf(line, i), posOf(line, i + 6))
    bend[i] = r > 0 && Number.isFinite(r) ? 1 / r : 0
  }
  const S = t?.samples
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const level = (s: number) => {
    if (!t || !S) return true
    const p = posOf(line, s)
    t.nearest(p.x, 0, p.z, hit)
    const step = Math.round(LOOP_RUN_IN / S.ds)
    const y = (k: number) => S.py[(((hit.index + k) % S.count) + S.count) % S.count]
    return Math.abs(y(-step) - y(0)) < 2 && Math.abs(y(step) - y(0)) < 2
  }
  // Keep away from the start grid and every other piece's stretch of road.
  const busy = [
    { s: sOf(line, d.startAt), before: 70 + LOOP_RUN_IN, after: 25 + 80 },
    ...d.pieces.filter((_, i) => i !== index).map((p) => ({ s: sOf(line, p.at), before: LOOP_RUN_IN + 80, after: p.type === 'wallride' ? (p.length ?? TRACK_DEFAULTS.wallride.length) + LOOP_RUN_IN : LOOP_RUN_IN + 80 })),
  ]
  const s0 = sOf(line, loop.at)
  const spots: { s: number; away: number }[] = []
  for (let s = 0; s < L; s += 5) {
    let worst = 0
    for (let k = -LOOP_RUN_IN; k <= LOOP_RUN_IN && worst <= 1 / LOOP_MIN_RADIUS; k += 1) worst = Math.max(worst, bend[(((Math.round(s + k)) % N) + N) % N])
    if (worst > 1 / LOOP_MIN_RADIUS) continue
    if (busy.some((b) => { const ahead = wrapS(s - b.s, L); return ahead <= b.after || L - ahead <= b.before })) continue
    const away = Math.min(wrapS(s - s0, L), wrapS(s0 - s, L))
    if (away < 15) continue
    spots.push({ s, away })
  }
  spots.sort((a, b) => a.away - b.away)
  const out: number[] = []
  for (const sp of spots) {
    if (out.length >= limit) break
    if (out.some((o) => Math.min(wrapS(o - sp.s, L), wrapS(sp.s - o, L)) < 40)) continue
    if (!level(sp.s)) continue
    out.push(sp.s)
  }
  return out.map((s) => atOf(line, s))
}

/** Move loop `index` to other straight, level spots, nearest first. */
function* moveLoop(d: Draft, index: number, ctx: FixContext): Generator<Candidate> {
  const loop = d.pieces[index]
  if (!loop || loop.type !== 'loop') return
  const rc = roadCurve(d.points)
  for (const spot of loopSpots(d, index, ctx.before.runtime, 6)) {
    const moved = Math.round(Math.min(metresBetween(rc, loop.at, spot), metresBetween(rc, spot, loop.at)))
    const next: Draft = { ...d, pieces: d.pieces.map((p, i) => (i === index ? { ...p, at: round3(spot) } : { ...p })) }
    yield { draft: next, did: `moved the loop ${moved} m along the road, to a straight where it fits.` }
  }
}

/**
 * Where the start line could go, nearest first: spots where the whole grid (50 m
 * behind the line to 10 m after it) is straight and level ON THE BUILT ROAD, the
 * same test as the game's start check (with a little to spare, since moving the
 * start moves where the builder keeps the road level), and no piece but a boost
 * pad or speed trap is on it. `limit` spots at least 40 m apart.
 */
function startSpots(d: Draft, t: TrackRuntime | null, limit: number): number[] {
  const x = t ? trackInternals(t) : undefined
  if (!t || !x) return []
  const S = t.samples
  const L = t.length
  const line = roadLine(d.points)
  const blocked = d.pieces.filter((p) => p.type !== 'boost' && p.type !== 'speedtrap').map((p) => p.at)
  const spots: { s: number; away: number }[] = []
  for (let s = 0; s < L; s += 5) {
    let ok = true
    for (let sv = s - 55; sv <= s + 15 && ok; sv += 1) {
      const i = Math.round(t.wrapS(sv) / S.ds) % S.count
      if (Math.abs(S.curvature[i]) >= 0.85 / 400 || (Math.abs(S.bank[i]) * 180) / Math.PI >= 2.5 || S.surface[i] !== SURFACE_CODE.road) ok = false
    }
    if (!ok) continue
    const at = x.atOfS(s)
    const sAt = sOf(line, at)
    if (blocked.some((b) => { const ahead = wrapS(sOf(line, b) - sAt, line.length); return ahead <= 25 || ahead >= line.length - 70 })) continue
    spots.push({ s, away: Math.min(s, L - s) })
  }
  spots.sort((a, b) => a.away - b.away)
  const out: number[] = []
  for (const sp of spots) {
    if (out.length >= limit) break
    if (out.some((o) => Math.abs(t.deltaS(o, sp.s)) < 40)) continue
    out.push(sp.s)
  }
  return out.map((s) => x.atOfS(s))
}

// ---------------------------------------------------------------- which ways to try, per problem

/** The ways to mend problem `p`, gentlest first (exported for the self-test). */
export function* candidatesFor(p: Problem, d: Draft, ctx: FixContext): Generator<Candidate> {
  const at = problemAt(p, d)
  const some = function* (...list: (Candidate | null)[]) {
    for (const c of list) if (c) yield c
  }
  if (p.source === 'gate' && p.gate) {
    const g = p.gate
    switch (g.name) {
      case 'line':
        // The line gate often says no place: then the whole road, like Smooth the road.
        if (at === null) {
          yield* some(smoothNear(d, null, 0, 1, ctx), smoothNear(d, null, 0, 2, ctx))
          return
        }
        for (const [reach, passes] of [[90, 1], [140, 2], [200, 3]] as const) yield* some(smoothNear(d, at, reach, passes, ctx))
        return
      case 'smooth':
        if (at === null) return
        yield* some(smoothNear(d, at, 90, 1, ctx), smoothHeightsNear(d, at, 60, ctx), smoothNear(d, at, 140, 2, ctx), smoothHeightsNear(d, at, 120, ctx))
        return
      case 'banking': {
        if (at === null) return
        // A bank Josh set by hand near here: rework his stretch first (it is his setting that tips too suddenly).
        const line = roadLine(d.points)
        const sAt = sOf(line, at)
        yield* handBankWays(d, sAt - 30, sAt + 30, ctx)
        yield* some(easeBank(d, at, 70, 1, ctx), scaleBankNear(d, at, 120, 0.6, ctx), easeBank(d, at, 120, 1, ctx), smoothNear(d, at, 120, 1, ctx), easeBank(d, at, 160, 0.7, ctx), scaleBankNear(d, at, 200, 0, ctx))
        return
      }
      case 'crest': {
        const ats = gateAts(g)
        const a0 = ats[0] ?? at
        const a1 = ats[1] ?? a0
        if (a0 === null || a1 === null) return
        const line = roadLine(d.points)
        const len = wrapS(sOf(line, a1) - sOf(line, a0), line.length)
        const mid = atOf(line, sOf(line, a0) + len / 2)
        const reach = len / 2 + 60
        // The roll is next to a bank Josh set by hand: rework his stretch first, keeping as much of his bank as works.
        yield* handBankWays(d, sOf(line, a0), sOf(line, a0) + len, ctx)
        yield* some(easeBank(d, mid, reach, 1, ctx), easeBank(d, mid, reach + 60, 1, ctx), scaleBankNear(d, mid, reach, 0.7, ctx), easeBank(d, mid, reach + 60, 0.7, ctx), smoothNear(d, mid, reach + 40, 1, ctx), easeBank(d, mid, reach + 120, 0.5, ctx))
        return
      }
      case 'bridges':
      case 'ground':
        if (!p.at) return
        // Over a road banked by hand: raise the bridge or ease the bank under it, before anything else.
        yield* bankedBridgeWays(d, p.at, ctx)
        yield* bridgeAt(d, p.at, ctx)
        return
      case 'loops':
      case 'surface': {
        const loop = nearestLoop(d, at)
        if (loop < 0) return
        if (g.name === 'surface') {
          const want = Number(/radius of about (\d+) m/.exec(g.message)?.[1])
          if (!Number.isFinite(want)) return
          for (const r of [want, want + 2]) {
            yield { draft: { ...d, pieces: d.pieces.map((x, i) => (i === loop && x.type === 'loop' ? { ...x, radius: r } : { ...x })) }, did: `made the loop bigger (${r} m round).` }
          }
          return
        }
        yield* moveLoop(d, loop, ctx)
        return
      }
      case 'start.at': {
        const rc = roadCurve(d.points)
        const tried: number[] = []
        for (const spot of [...startSpots(d, ctx.before.runtime, 4), nearestStraightStart(d.points, d.startAt, d.pieces)]) {
          if (spot === null || tried.some((t) => Math.min(metresBetween(rc, t, spot), metresBetween(rc, spot, t)) < 20)) continue
          tried.push(spot)
          const moved = Math.round(Math.min(metresBetween(rc, d.startAt, spot), metresBetween(rc, spot, d.startAt)))
          yield { draft: { ...d, startAt: round3(spot) }, did: `moved the start line ${moved} m, onto a straight.` }
        }
        return
      }
    }
    return
  }
  if (p.source === 'validator' && p.issue) {
    const m = p.issue.message
    const pi = /^(road\.points|pieces|props|cores)\[(\d+)\]/.exec(p.issue.path)
    const index = pi ? Number(pi[2]) : -1
    if (/is within 2 m of point/.test(m) && pi?.[1] === 'road.points') {
      const count = d.points.length
      if (count <= 8) return
      yield {
        draft: { ...d, points: d.points.filter((_, i) => i !== index), pieces: d.pieces.map((x) => ({ ...x, at: atAfterDelete(x.at, index, count) })), startAt: atAfterDelete(d.startAt, index, count) },
        did: `took out road point ${index + 1} (it sat on top of the one before).`,
      }
      return
    }
    if (/is outside the/.test(m) && pi) {
      const lim = roadBound(d.environment) - 10
      const clamp = (v: number) => Math.round(Math.max(-lim, Math.min(lim, v)) * 10) / 10
      const next: Draft = { ...d, points: d.points.map((x) => ({ ...x })), props: d.props.map((x) => ({ ...x })), cores: d.cores.map((x) => ({ ...x })) }
      const list = pi[1] === 'road.points' ? next.points : pi[1] === 'props' ? next.props : pi[1] === 'cores' ? next.cores : null
      const spot = list?.[index]
      if (!spot) return
      spot.x = clamp(spot.x)
      spot.z = clamp(spot.z)
      yield { draft: next, did: 'pulled it back inside the world.' }
      return
    }
    if (p.issue.path === 'road.points' && /crosses itself/.test(m)) {
      if (p.at) yield* bridgeAt(d, p.at, ctx)
      return
    }
    if (p.issue.path === 'road.points' && /radius/.test(m)) {
      if (at === null) return
      for (const [reach, passes] of [[80, 1], [130, 2], [180, 3]] as const) yield* some(smoothNear(d, at, reach, passes, ctx))
      return
    }
    if (pi?.[1] === 'pieces') {
      const piece = d.pieces[index]
      if (!piece) return
      if (piece.type === 'loop') {
        yield* moveLoop(d, index, ctx)
        return
      }
      const rc = roadCurve(d.points)
      const moveTo = (newAt: number, did: string): Candidate => ({ draft: { ...d, pieces: d.pieces.map((x, i) => (i === index ? { ...x, at: round3(wrapAt(newAt, d.points.length)) } : { ...x })) }, did })
      if (/on or next to the start grid/.test(m)) {
        const len = piece.type === 'wallride' ? (piece.length ?? TRACK_DEFAULTS.wallride.length) : 0
        for (const metres of [35, 55, 80]) yield moveTo(advanceAt(rc, d.startAt, metres), `moved the ${piece.type === 'wallride' ? 'wall ride' : piece.type} to ${metres} m after the start line, off the grid.`)
        for (const metres of [90, 120]) yield moveTo(advanceAt(rc, d.startAt, -(metres + len)), `moved the ${piece.type === 'wallride' ? 'wall ride' : piece.type} to before the start grid.`)
        return
      }
      if (/sticks out past the road edge/.test(m) && piece.type === 'ramp') {
        const room = Math.max(0, d.width / 2 - (piece.width ?? TRACK_DEFAULTS.ramp.width) / 2 - 0.3)
        const offset = Math.max(-room, Math.min(room, piece.offset ?? 0))
        const next: Draft = { ...d, pieces: d.pieces.map((x, i) => (i === index && x.type === 'ramp' ? { ...x, offset: Math.round(offset * 10) / 10 } : { ...x })) }
        yield { draft: next, did: 'slid the ramp back onto the road.' }
        return
      }
      if (/overlaps/.test(m)) {
        for (const metres of [30, -30, 60, -60, 100, -100]) yield moveTo(advanceAt(rc, piece.at, metres), `moved the ${piece.type === 'wallride' ? 'wall ride' : piece.type} ${Math.abs(metres)} m ${metres > 0 ? 'on' : 'back'} along the road, clear of the other piece.`)
        return
      }
    }
    return
  }
  if (p.source === 'cleanup' && p.note?.code === 'tight-corner' && at !== null) {
    for (const [reach, passes] of [[80, 1], [130, 2], [180, 3]] as const) yield* some(smoothNear(d, at, reach, passes, ctx))
  }
}

/** The loop nearest `at` (index into pieces), or -1. */
function nearestLoop(d: Draft, at: number | null): number {
  let best = -1
  let bestD = Infinity
  d.pieces.forEach((x, i) => {
    if (x.type !== 'loop') return
    const dd = at === null ? 0 : Math.min(wrapAt(x.at - at, d.points.length), wrapAt(at - x.at, d.points.length))
    if (dd < bestD) {
      bestD = dd
      best = i
    }
  })
  return best
}

// ---------------------------------------------------------------- did it work?

/** A validator message with its numbers taken out. */
function shapeOf(message: string): string {
  return message.replace(/-?\d+(?:\.\d+)?/g, '#')
}

/** Is problem `p` gone from the mended draft (built and checked as `after`)? */
export function isResolved(p: Problem, after: Judged, mended: Draft): boolean {
  if (p.source === 'gate' && p.gate) {
    const g = p.gate
    return !after.gates.some((x) => x.name === g.name && x.level === g.level)
  }
  if (p.source === 'validator' && p.issue) {
    const list = p.tone === 'bad' ? after.errors : after.warnings
    const want = shapeOf(p.issue.message)
    const kind = p.issue.path.replace(/\[\d+\].*$/, '')
    return !list.some((x) => shapeOf(x.message) === want && x.path.replace(/\[\d+\].*$/, '') === kind && (x.path === p.issue?.path || nearIssue(x.path, mended, p.at)))
  }
  if (p.source === 'cleanup' && p.note?.code === 'tight-corner' && p.at) {
    const line = roadLine(mended.points)
    const s = sOf(line, nearestOnRoad(roadCurve(mended.points), p.at).at)
    return tightestBetween(line, s - 40, s + 40).radius >= MIN_RADIUS * 0.98
  }
  return false
}

/** Is the thing at `path` (a road point or piece) within 40 m of `spot`? */
function nearIssue(path: string, d: Draft, spot: P | null): boolean {
  if (!spot) return true
  const m = /^(road\.points|pieces)\[(\d+)\]/.exec(path)
  if (!m) return true
  const i = Number(m[2])
  const p = m[1] === 'road.points' ? d.points[i] : d.pieces[i] ? frameAt(roadCurve(d.points), d.pieces[i].at).p : null
  return !!p && dist(p, spot) < 40
}

/** A fix may mend a hand-set bank in one place and then go on to the next one the same check names, this many times. */
const CHASE_DEPTH = 3
/** A check's failure counts as somewhere else once its pin is this far away on the map, metres. */
const MOVED_AWAY = 150

/**
 * Looking for a fix for one problem, one try at a time: each step() builds and
 * checks one way of mending it (a few tenths of a second on a long road), so the
 * editor can look in the background between frames (fixActions.ts) and only
 * offer Fix it once a fix has really been found. runFix() runs it to the end.
 *
 * The rule: a way is kept only if the problem goes away and no other check that
 * passed before fails after. One more thing for SUDDEN TILT and CAR GOES LIGHT:
 * a road can have several banks Josh set by hand, and the check only names the
 * worst one. If no way clears the whole check but one mends this spot (the check
 * now names a place far from here) without breaking anything, the search goes on
 * from there to mend the next one, and the two count as one fix.
 */
export class FixSearch {
  /** The answer, once the search has finished. */
  result: FixResult | null = null
  private readonly ways: Iterator<Candidate>
  private tried = 0
  private first = ''
  /** The first way that mended this spot while the check still failed somewhere else. */
  private progress: { c: Candidate; after: Judged; next: Problem } | null = null
  /** The search for that next spot, going on from `progress`. */
  private sub: FixSearch | null = null

  constructor(
    readonly problem: Problem,
    readonly draft: Draft,
    readonly ctx: FixContext,
    ways?: Iterable<Candidate>,
    private readonly depth = 0,
  ) {
    this.ways = (ways ?? candidatesFor(problem, draft, ctx))[Symbol.iterator]()
    if (problem.remedy.kind !== 'fix') this.result = { ok: false, reason: problem.remedy.does }
  }

  /** How many builds this search has done so far. */
  get tries(): number {
    return this.tried + (this.sub?.tries ?? 0)
  }

  /** Try one more way (one build and check). True once the search has finished. */
  step(): boolean {
    if (this.result) return true
    if (this.sub) {
      if (!this.sub.step()) return false
      const r = this.sub.result as FixResult
      const prog = this.progress as { c: Candidate; after: Judged }
      this.result = r.ok ? { ok: true, draft: r.draft, did: `${prog.c.did} ${upperFirst(r.did ?? '')}`, after: r.after } : { ok: false, reason: this.first || r.reason }
      return true
    }
    if (this.tried >= MAX_TRIES) return this.finish()
    const n = this.ways.next()
    if (n.done) return this.finish()
    const c = n.value
    this.tried++
    const { ctx, problem: p } = this
    const after = judgeDraft(c.draft, ctx.id, ctx.params, ctx.before.runtime)
    if (!after.runtime) {
      this.first ||= `the game couldn't build it that way (${after.error})`
      return false
    }
    const fresh = newFailures(ctx.before.gates, after.gates)
    if (!fresh.length && isResolved(p, after, c.draft)) {
      this.result = { ok: true, draft: c.draft, did: c.did, after }
      return true
    }
    if (!fresh.length && !this.progress && this.depth < CHASE_DEPTH) {
      const next = movedOn(p, after, c.draft)
      if (next) this.progress = { c, after, next }
    }
    if (!this.first) {
      const g: TrackGate | undefined = fresh.find((x) => !isGameBug(x)) ?? fresh[0]
      this.first = g ? `every way it tried made another problem (${lowerFirst(gateTitle(g, c.draft)).replace(/\.$/, '')})` : `nothing it tried made the problem go away`
    }
    return false
  }

  /** No way cleared the check: go on from a way that mended this spot, if there was one; else say why not. */
  private finish(): boolean {
    if (this.progress) {
      const { c, after, next } = this.progress
      this.sub = new FixSearch(next, c.draft, { ...this.ctx, before: after }, undefined, this.depth + 1)
      return false
    }
    this.result = this.tried ? { ok: false, reason: this.first } : { ok: false, reason: "it couldn't find a way to mend it here" }
    return true
  }
}

/**
 * After a try that didn't clear the check: is the same check (SUDDEN TILT or CAR GOES
 * LIGHT) now failing somewhere else, far from where it was? Then this spot is mended,
 * and the problem there (on the tried draft) is returned to go on with.
 */
function movedOn(p: Problem, after: Judged, mended: Draft): Problem | null {
  if (p.source !== 'gate' || !p.gate || (p.gate.name !== 'crest' && p.gate.name !== 'banking') || !p.at) return null
  const name = p.gate.name
  const list = problemsOf({ draft: mended, gates: after.gates, errors: after.errors, warnings: after.warnings, notes: NO_NOTES })
  const next = list.find((x) => x.source === 'gate' && x.gate?.name === name && x.gate.level === 'fail')
  if (!next || !next.at || dist(next.at, p.at) < MOVED_AWAY || next.remedy.kind !== 'fix') return null
  return next
}

/**
 * Mend problem `p` on draft `d`: try each way in turn, built and checked, and
 * keep the first that makes it go away without making any other check fail.
 * (`ways` defaults to candidatesFor; the self-test hands in its own to prove the rule.)
 */
export function runFix(p: Problem, d: Draft, ctx: FixContext, ways?: Iterable<Candidate>): FixResult {
  const search = new FixSearch(p, d, ctx, ways)
  while (!search.step()) {
    // one build and check per step
  }
  return search.result as FixResult
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** A problem's kind, without where it is: Fix all tries each kind once. */
function kindOf(p: Problem): string {
  return p.source === 'gate' ? `gate:${p.gate?.name}` : p.source === 'validator' ? `v:${p.issue?.path.replace(/\[\d+\]/, '[]')}:${shapeOf(p.issue?.message ?? '')}` : `note:${p.note?.code}`
}

/**
 * Fix all: mend every problem that has a Fix it button, one after another,
 * each built and checked on top of the last (so no fix can undo another or
 * make a check fail). Returns the mended draft and what was and wasn't done.
 */
export function runFixAll(d: Draft, ctx: FixContext, notes: readonly StrokeIssue[], known?: ReadonlyMap<string, FixResult>): { draft: Draft; after: Judged; did: string[]; couldNot: string[] } {
  let cur = d
  let judged = ctx.before
  const did: string[] = []
  const couldNot: string[] = []
  // Each kind of problem is tried once; one that couldn't be mended gets one more go after a
  // later fix lands (a racing line that fails because of a loop on a bend passes once the loop moves).
  /** Per kind: how many tries so far, and how many fixes had landed when it last failed (-1: it worked). */
  const tries = new Map<string, { count: number; failedAfter: number }>()
  const eligible = (k: string) => {
    const t = tries.get(k)
    return !t || (t.count < 3 && t.failedAfter < did.length)
  }
  for (let round = 0; round < 20; round++) {
    const list = problemsOf({ draft: cur, gates: judged.gates, errors: judged.errors, warnings: judged.warnings, notes: round === 0 ? notes : NO_NOTES })
    const next = list.find((x) => x.remedy.kind === 'fix' && eligible(kindOf(x)))
    if (!next) break
    const k = kindOf(next)
    // On the draft as it was, the background search (fixActions.ts) may already know the answer.
    const r = (cur === d ? known?.get(next.key) : undefined) ?? runFix(next, cur, { ...ctx, before: judged })
    if (r.ok && r.draft && r.after) {
      cur = r.draft
      judged = r.after
      did.push(r.did ?? '')
      // The same kind can still be failing somewhere else (a second kink): it may go again.
      tries.set(k, { count: (tries.get(k)?.count ?? 0) + 1, failedAfter: -1 })
    } else tries.set(k, { count: (tries.get(k)?.count ?? 0) + 1, failedAfter: did.length })
  }
  // What is still there with a Fix it button, but couldn't be mended.
  const left = problemsOf({ draft: cur, gates: judged.gates, errors: judged.errors, warnings: judged.warnings, notes: NO_NOTES })
  for (const x of left) if (x.remedy.kind === 'fix' && tries.has(kindOf(x))) couldNot.push(x.title)
  return { draft: cur, after: judged, did, couldNot }
}
