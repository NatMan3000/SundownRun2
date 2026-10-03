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
import type { TrackGate } from '../track/gates'
import { SURFACE_CODE, type NearestHit, type TrackRuntime } from '../track/types'
import { trackInternals } from '../track/build'
import type { StrokeIssue } from './cleanup'
import type { Draft } from './draft'
import { roadBound } from './draftFile'
import { type GroundFn, crossingNear, roadCrossings, swapDraft, tryOneWay } from './bridges'
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
const MAX_TRIES = 8

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
  return { draft: withPoints(d, out, even.mapAt, ctx), did: `eased the tilt over ${Math.round(2 * reach)} m of road there${scale < 1 ? ', with less bank' : ''} (set by hand: the Stretch tool's Auto puts it back).` }
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

/** Lift the upper road at the crossing near `spot` onto a proper bridge (or swap, or make one where the roads meet). */
function* bridgeAt(d: Draft, spot: P, ctx: FixContext): Generator<Candidate> {
  const ground = ctx.world.pointGround ?? FLAT
  const hit = crossingNear(roadCrossings(d.points, ground), spot, 60)
  if (!hit) return
  const c = hit.crossing
  const o = { id: ctx.id, pointGround: ctx.world.pointGround, params: ctx.params, gatesBefore: ctx.before.gates }
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
      case 'banking':
        if (at === null) return
        yield* some(easeBank(d, at, 70, 1, ctx), scaleBankNear(d, at, 120, 0.6, ctx), easeBank(d, at, 120, 1, ctx), smoothNear(d, at, 120, 1, ctx), easeBank(d, at, 160, 0.7, ctx), scaleBankNear(d, at, 200, 0, ctx))
        return
      case 'crest': {
        const ats = gateAts(g)
        const a0 = ats[0] ?? at
        const a1 = ats[1] ?? a0
        if (a0 === null || a1 === null) return
        const line = roadLine(d.points)
        const len = wrapS(sOf(line, a1) - sOf(line, a0), line.length)
        const mid = atOf(line, sOf(line, a0) + len / 2)
        const reach = len / 2 + 60
        yield* some(easeBank(d, mid, reach, 1, ctx), easeBank(d, mid, reach + 60, 1, ctx), scaleBankNear(d, mid, reach, 0.7, ctx), easeBank(d, mid, reach + 60, 0.7, ctx), smoothNear(d, mid, reach + 40, 1, ctx), easeBank(d, mid, reach + 120, 0.5, ctx))
        return
      }
      case 'bridges':
      case 'ground':
        if (p.at) yield* bridgeAt(d, p.at, ctx)
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

/**
 * Mend problem `p` on draft `d`: try each way in turn, built and checked, and
 * keep the first that makes it go away without making any other check fail.
 * (`ways` defaults to candidatesFor; the self-test hands in its own to prove the rule.)
 */
export function runFix(p: Problem, d: Draft, ctx: FixContext, ways: Iterable<Candidate> = candidatesFor(p, d, ctx)): FixResult {
  if (p.remedy.kind !== 'fix') return { ok: false, reason: p.remedy.does }
  let first = ''
  let tried = 0
  for (const c of ways) {
    if (tried++ >= MAX_TRIES) break
    const after = judgeDraft(c.draft, ctx.id, ctx.params, ctx.before.runtime)
    if (!after.runtime) {
      first ||= `the game couldn't build it that way (${after.error})`
      continue
    }
    const fresh = newFailures(ctx.before.gates, after.gates)
    if (!fresh.length && isResolved(p, after, c.draft)) return { ok: true, draft: c.draft, did: c.did, after }
    if (!first) {
      const g: TrackGate | undefined = fresh.find((x) => !isGameBug(x)) ?? fresh[0]
      first = g ? `every way it tried made another problem (${lowerFirst(gateTitle(g, c.draft)).replace(/\.$/, '')})` : `nothing it tried made the problem go away`
    }
  }
  if (!tried) return { ok: false, reason: "it couldn't find a way to mend it here" }
  return { ok: false, reason: first }
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
export function runFixAll(d: Draft, ctx: FixContext, notes: readonly StrokeIssue[]): { draft: Draft; after: Judged; did: string[]; couldNot: string[] } {
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
    const r = runFix(next, cur, { ...ctx, before: judged })
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
